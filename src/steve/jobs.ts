// deno-lint-ignore-file no-explicit-any

import { createPubSub } from "@marianmeres/pubsub";
import process from "node:process";
import type pg from "pg";
import { _claimNextJob } from "./job/_claim-next.ts";
import { _create } from "./job/_create.ts";
import { _executeJob } from "./job/_execute.ts";
import { _fetchAll, _find } from "./job/_find.ts";
import { _healthPreview } from "./job/_health-preview.ts";
import { _logAttemptErrorFetchAll } from "./job/_log-attempt.ts";
import { _markExpired } from "./job/_mark-expired.ts";
import {
	_initialize,
	_schemaCreate,
	_schemaDrop,
	_uninstall,
} from "./job/_schema.ts";
import { pgQuoteValue } from "./utils/pg-quote.ts";
import { sleep } from "./utils/sleep.ts";

/** Job statuses */
export const JOB_STATUS = {
	PENDING: "pending",
	RUNNING: "running",
	COMPLETED: "completed",
	FAILED: "failed",
	EXPIRED: "expired", // after in "running" state for too long
};

/** Job attempt log statuses */
export const ATTEMPT_STATUS = {
	SUCCESS: "success",
	ERROR: "error",
};

export const BACKOFF_STRATEGY = {
	NONE: "none",
	EXP: "exp", // 2^attempts seconds
	// ... add another if needed ...
};

/** Job handler worker. Returned result will be saved under `result` */
export type JobHandler = (job: Job) => any | Promise<any>;

/** Internal context passed to job utilities */
export interface JobContext {
	db: pg.Pool | pg.Client;
	tableNames: {
		tableJobs: string;
		tableAttempts: string;
	};
	logger: Logger;
	pubsubSuccess: ReturnType<typeof createPubSub>;
	pubsubFailure: ReturnType<typeof createPubSub>;
}

/** The job row */
export interface Job {
	id: number;
	uid: string;
	type: string;
	payload: Record<string, any>;
	result: null | undefined | Record<string, any>;
	status:
		| typeof JOB_STATUS.PENDING
		| typeof JOB_STATUS.RUNNING
		| typeof JOB_STATUS.COMPLETED
		| typeof JOB_STATUS.FAILED;
	attempts: number;
	max_attempts: number;
	created_at: Date;
	updated_at: Date;
	started_at: Date;
	completed_at: Date;
	run_at: Date;
	backoff_strategy: typeof BACKOFF_STRATEGY.NONE | typeof BACKOFF_STRATEGY.EXP;
}

/** The job attempt log row */
export interface JobAttempt {
	id: number;
	job_id: string;
	attempt_number: number;
	started_at: Date;
	completed_at: Date;
	status: typeof ATTEMPT_STATUS.SUCCESS | typeof ATTEMPT_STATUS.ERROR;
	error_message: null;
	error_details: null | Record<"stack" | string, any>;
}

/** Supported userland values when creating new job */
export interface JobCreateDTO {
	type: string;
	payload: Record<string, any>;
	max_attempts?: number;
	backoff_strategy?: typeof BACKOFF_STRATEGY.NONE | typeof BACKOFF_STRATEGY.EXP;
}

/** Provided logger */
export type Logger = (...args: any[]) => void;

/** Factory options */
export interface JobsOptions {
	jobHandler: JobHandler;
	/** pg.Pool or pg.Client instance */
	db: pg.Pool | pg.Client;
	/** Useful for non-public schema. Leave empty or provide a schema with appending dot "myschema." */
	tablePrefix?: string;
	/** Job processor polling interval in milliseconds (default 1_000) */
	pollTimeoutMs?: number;
	/**  */
	logger?: Logger;
	/** Will listen on SIGTERM and try to gracefully stop all running job processors. */
	gracefulSigterm?: boolean;
}

const defaultLogger = (...args: any[]) => {
	console.log(`[jobs] [${new Date().toISOString()}]`, ...args);
};

/**  */
function tableNames(tablePrefix: string = ""): JobContext["tableNames"] {
	return {
		tableJobs: `${tablePrefix}job`, // main
		tableAttempts: `${tablePrefix}job_attempt_log`, // debug log
	};
}

/** Core public factory api. Will create the jobs handling manager */
export function createJobs(options: JobsOptions): {
	start: (processorsCount?: number) => Promise<void>;
	stop: () => Promise<void>;
	create(
		type: string,
		payload: Record<string, any>,
		options: Partial<{
			max_attempts: JobCreateDTO["max_attempts"];
			backoff_strategy: JobCreateDTO["backoff_strategy"];
		}>
	): Promise<Job>;
	find(
		uid: string,
		withAttempts?: boolean
	): Promise<{ job: Job; attempts: null | JobAttempt[] }>;
	fetchAll(
		status?: undefined | null | Job["status"] | Job["status"][],
		options?: Partial<{
			limit: number | string;
			offset: number | string;
		}>
	): Promise<Job[]>;
	cleanup(): Promise<void>;
	healthPreview(sinceHours?: number): Promise<any[]>;
	uninstall(): Promise<void>;
	onSuccess(type: string, cb: (job: Job) => void): void;
	onFailure(type: string, cb: (job: Job) => void): void;
	unsubscribeAll(): void;
} {
	const {
		jobHandler,
		db,
		pollTimeoutMs = 1_000,
		tablePrefix = "",
		logger = defaultLogger,
		gracefulSigterm = true,
	} = options || {};

	let isShuttingDown = false;
	let wasInitialized = false;
	const activeJobs = new Set();
	let jobProcessors: Promise<void>[] = [];
	const pubsubSuccess = createPubSub();
	const pubsubFailure = createPubSub();

	const context: JobContext = {
		db,
		tableNames: tableNames(tablePrefix),
		logger,
		pubsubSuccess,
		pubsubFailure,
	};

	//
	async function _initializeOnce() {
		if (!wasInitialized) {
			await _initialize(context);
			logger?.(`System initialized`);
			wasInitialized = true;
		}
	}

	//
	async function _processJobs(processorId: string): Promise<void> {
		while (!isShuttingDown) {
			const job = await _claimNextJob(context);
			if (job) {
				activeJobs.add(job.id);
				try {
					logger?.(`Executing job ${job.id} (${job.uid}) ...`);
					await _executeJob(context, job, jobHandler);
				} finally {
					activeJobs.delete(job.id);
				}
			} else {
				await sleep(pollTimeoutMs);
			}
		}

		// we are here only if there is a shutdown in progress

		if (activeJobs.size > 0) {
			logger?.(`Waiting for ${activeJobs.size} jobs to complete...`);
			while (activeJobs.size > 0) {
				await sleep(100);
			}
		}

		logger?.(`Job processor '${processorId}' stopped`);
	}

	// This is a graceful stop (will wait for all processors to finish)
	async function stop() {
		isShuttingDown = true;
		await Promise.all(jobProcessors);
		jobProcessors = [];
		isShuttingDown = false;
	}

	if (gracefulSigterm) {
		process.on("SIGTERM", async () => {
			logger?.(`SIGTERM detected...`);
			await stop();
			// not calling the exit here... this should be a responsibility of the consumer
			// process.exit(0);
		});
	}

	return {
		/** Will start the jobs processing. Reasonable value of concurrent workers (job processors)
		 * would be 2-4. */
		async start(processorsCount: number = 2): Promise<void> {
			if (isShuttingDown) {
				const msg = `Cannot start (shutdown in progress detected)`;
				logger?.(msg);
				throw new Error(msg);
			}

			await _initializeOnce();

			for (let i = 0; i < processorsCount; i++) {
				const processorId = `processor-${i}`;
				const processor = _processJobs(processorId);
				jobProcessors.push(processor);
				logger?.(`Processor '${processorId}' initialized`);
			}
		},

		/** Will gracefully stop all running job processors */
		stop,

		/** Will create new pending job, ready to be processed */
		async create(
			type: string,
			payload: Record<string, any> = {},
			options: Partial<{
				max_attempts: JobCreateDTO["max_attempts"];
				backoff_strategy: JobCreateDTO["backoff_strategy"];
			}> = {}
		): Promise<Job> {
			const { max_attempts = 3, backoff_strategy = BACKOFF_STRATEGY.EXP } =
				options || {};

			await _initializeOnce();

			return _create(context, {
				type,
				payload,
				max_attempts,
				backoff_strategy,
			});
		},

		/** Will try to find job row by its uid */
		async find(
			uid: string,
			withAttempts: boolean = false
		): Promise<{ job: Job; attempts: null | JobAttempt[] }> {
			await _initializeOnce();
			const job = await _find(context, uid);
			let attempts: null | any[] = null;

			if (job && withAttempts) {
				attempts = await _logAttemptErrorFetchAll(context, job.id);
			}

			return { job, attempts };
		},

		/** Will fetch all, optionally filtering by status(es) */
		async fetchAll(
			status: undefined | null | Job["status"] | Job["status"][] = null,
			options: Partial<{
				limit: number | string;
				offset: number | string;
			}> = {}
		): Promise<Job[]> {
			await _initializeOnce();

			let where = null;
			if (status) {
				if (!Array.isArray(status)) status = [status];
				status = [...new Set(status.filter(Boolean))];
				if (status.length) {
					where = `status IN (${status.map(pgQuoteValue).join(",")})`;
				}
			}

			return _fetchAll(context, where, options);
		},

		/** Will do some maintenance cleanups. It's up to the consumer to decide the
		 * overall cleanup strategy. */
		async cleanup() {
			// this does not make much sense to initialize on cleanup... but keeping the convention
			await _initializeOnce();
			return _markExpired(context);
			// todo: hard delete old?
		},

		/** Will collect some stats... */
		async healthPreview(sinceHours = 1) {
			await _initializeOnce();
			return _healthPreview(context, sinceHours);
		},

		/** Will remove related tables. */
		uninstall() {
			return _uninstall(context);
		},

		/** Subscribe callback for a completed job type */
		onSuccess(type: string, cb: (job: Job) => void) {
			return pubsubSuccess.subscribe(type, cb);
		},

		/**
		 * Subscribe callback for a failed job type. Intentionally not calling this "onError",
		 * because "errors" are handled and retried... this callback is only triggered
		 * where all retries failed.
		 */
		onFailure(type: string, cb: (job: Job) => void) {
			return pubsubFailure.subscribe(type, cb);
		},

		/** Helper to unsub all listeners. Used in tests. */
		unsubscribeAll() {
			pubsubSuccess.unsubscribeAll();
			pubsubFailure.unsubscribeAll();
		},
	};
}

/** For manual hackings (used in tests). */
export function __jobsSchema(tablePrefix: string = ""): {
	drop: string;
	create: string;
} {
	const context = { tableNames: tableNames(tablePrefix) };
	return {
		drop: _schemaDrop(context),
		create: _schemaCreate(context),
	};
}
