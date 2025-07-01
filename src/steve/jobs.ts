// deno-lint-ignore-file no-explicit-any

import { createPubSub, type Unsubscriber } from "@marianmeres/pubsub";
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

/** Supported backoff strategies */
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
	pubsubAttempt: ReturnType<typeof createPubSub>;
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

/** Core jobs manager  */
export class Jobs {
	#db: pg.Pool | pg.Client;
	readonly jobHandler: JobHandler;
	readonly pollTimeoutMs: number;
	readonly logger: Logger;
	readonly gracefulSigterm: boolean;
	readonly tablePrefix: string;
	readonly pubsubSuccess: ReturnType<typeof createPubSub> = createPubSub();
	readonly pubsubFailure: ReturnType<typeof createPubSub> = createPubSub();
	readonly pubsubAttempt: ReturnType<typeof createPubSub> = createPubSub();
	readonly context: JobContext;

	#isShuttingDown = false;
	#wasInitialized = false;
	#activeJobs = new Set();
	#jobProcessors: Promise<void>[] = [];

	constructor(options: JobsOptions) {
		const {
			jobHandler,
			db,
			pollTimeoutMs = 1_000,
			tablePrefix = "",
			logger = defaultLogger,
			gracefulSigterm = true,
		} = options || {};

		this.#db = db;
		this.jobHandler = jobHandler;
		this.pollTimeoutMs = pollTimeoutMs;
		this.tablePrefix = tablePrefix;
		this.logger = logger;
		this.gracefulSigterm = gracefulSigterm;

		this.context = {
			db: this.#db,
			tableNames: tableNames(tablePrefix),
			logger: this.logger,
			pubsubSuccess: this.pubsubSuccess,
			pubsubFailure: this.pubsubFailure,
			pubsubAttempt: this.pubsubAttempt,
		};
	}

	async #initializeOnce() {
		if (!this.#wasInitialized) {
			await _initialize(this.context);
			this.#wasInitialized = true;
			this.logger?.(`System initialized`);

			if (this.gracefulSigterm) {
				process.on("SIGTERM", async () => {
					this.logger?.(`SIGTERM detected...`);
					await this.stop();
					// not calling the exit here... this should be a responsibility of the consumer
					// process.exit(0);
				});
			}
		}
	}

	async #processJobs(processorId: string): Promise<void> {
		while (!this.#isShuttingDown) {
			const job = await _claimNextJob(this.context);
			if (job) {
				this.#activeJobs.add(job.id);
				try {
					this.logger?.(`Executing job ${job.id}...`);
					await _executeJob(this.context, job, this.jobHandler);
				} finally {
					this.#activeJobs.delete(job.id);
				}
			} else {
				await sleep(this.pollTimeoutMs);
			}
		}

		// we are here only if there is a shutdown in progress

		if (this.#activeJobs.size > 0) {
			this.logger?.(`Waiting for ${this.#activeJobs.size} jobs to complete...`);
			while (this.#activeJobs.size > 0) {
				await sleep(100);
			}
		}

		this.logger?.(`Job processor '${processorId}' stopped`);
	}

	/** Will start the jobs processing. Reasonable value of concurrent workers (job processors)
	 * would be 2-4. */
	async start(processorsCount: number = 2): Promise<void> {
		if (this.#isShuttingDown) {
			const msg = `Cannot start (shutdown in progress detected)`;
			this.logger?.(msg);
			throw new Error(msg);
		}

		await this.#initializeOnce();

		for (let i = 0; i < processorsCount; i++) {
			const processorId = `processor-${i}`;
			const processor = this.#processJobs(processorId);
			this.#jobProcessors.push(processor);
			this.logger?.(`Processor '${processorId}' initialized`);
		}
	}

	/** Will gracefully stop all running job processors */
	async stop() {
		this.#isShuttingDown = true;
		await Promise.all(this.#jobProcessors);
		this.#jobProcessors = [];
		this.#isShuttingDown = false;
	}

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

		await this.#initializeOnce();

		return _create(this.context, {
			type,
			payload,
			max_attempts,
			backoff_strategy,
		});
	}

	/** Will try to find job row by its uid */
	async find(
		uid: string,
		withAttempts: boolean = false
	): Promise<{ job: Job; attempts: null | JobAttempt[] }> {
		await this.#initializeOnce();
		const job = await _find(this.context, uid);
		let attempts: null | any[] = null;

		if (job && withAttempts) {
			attempts = await _logAttemptErrorFetchAll(this.context, job.id);
		}

		return { job, attempts };
	}

	/** Will fetch all, optionally filtering by status(es) */
	async fetchAll(
		status: undefined | null | Job["status"] | Job["status"][] = null,
		options: Partial<{
			limit: number | string;
			offset: number | string;
			asc: number | string | boolean;
			sinceMinutesAgo: number;
		}> = {}
	): Promise<Job[]> {
		await this.#initializeOnce();

		let where = null;
		if (status) {
			if (!Array.isArray(status)) status = [status];
			status = [...new Set(status.filter(Boolean))];
			if (status.length) {
				where = `status IN (${status.map(pgQuoteValue).join(",")})`;
			}
		}

		return _fetchAll(this.context, where, options);
	}

	/** Will do some maintenance cleanups. It's up to the consumer to decide the
	 * overall cleanup strategy. */
	async cleanup(): Promise<void> {
		// this does not make much sense to initialize on cleanup... but keeping the convention
		await this.#initializeOnce();
		return _markExpired(this.context);
		// todo: hard delete old?
	}

	/** Will collect some stats... */
	async healthPreview(sinceMinutesAgo = 60): Promise<any[]> {
		await this.#initializeOnce();
		return _healthPreview(this.context, sinceMinutesAgo);
	}

	/** Will remove related tables. */
	uninstall(): Promise<void> {
		return _uninstall(this.context);
	}

	/** Subscribe callback to a completed job type(s) */
	onSuccess(type: string | string[], cb: (job: Job) => void): Unsubscriber {
		return this.#onEvent(this.pubsubSuccess, type, cb);
	}

	/**
	 * Subscribe callback to a failed job type(s). Intentionally not calling this "onError",
	 * because "errors" are handled and retried... this callback is only triggered
	 * where all retries failed.
	 */
	onFailure(type: string | string[], cb: (job: Job) => void): Unsubscriber {
		return this.#onEvent(this.pubsubFailure, type, cb);
	}

	/** Subcribe callback to every attempt */
	onAttempt(type: string | string[], cb: (job: Job) => void): Unsubscriber {
		return this.#onEvent(this.pubsubAttempt, type, cb);
	}

	/** Internal DRY helper */
	#onEvent(
		pubsub: ReturnType<typeof createPubSub>,
		type: string | string[],
		cb: (job: Job) => void
	): Unsubscriber {
		const types = Array.isArray(type) ? type : [type];
		const unsubs: any[] = [];
		types.forEach((t) => unsubs.push(pubsub.subscribe(t, cb)));
		return () => unsubs.forEach((u) => u());
	}

	/** Helper to unsub all listeners. Used in tests. */
	unsubscribeAll(): void {
		this.pubsubSuccess.unsubscribeAll();
		this.pubsubFailure.unsubscribeAll();
	}

	/** For manual hackings (used in tests). */
	static __schema(tablePrefix: string = ""): {
		drop: string;
		create: string;
	} {
		const context = { tableNames: tableNames(tablePrefix) };
		return {
			drop: _schemaDrop(context),
			create: _schemaCreate(context),
		};
	}
}
