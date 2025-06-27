// deno-lint-ignore-file no-explicit-any

import type pg from "pg";
import { initialize } from "./initialize.ts";
import process from "node:process";
import { sleep } from "./utils/sleep.ts";
import { _claimNextJob } from "./job/_claim-next.ts";
import { _executeJob } from "./job/_execute.ts";
import { _markExpired } from "./job/_mark-expired.ts";
import { _healhPreview } from "./job/_health-preview.ts";

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

/** Job handler worker */
export type JobHandler = (job: Job) => Promise<void>;

/** context passed to job utilities */
export interface JobContext {
	db: pg.Pool;
	tableNames: {
		tableJobs: string;
		tableAttempts: string;
	};
	logger: Logger;
}

/** The job row */
export interface Job {
	id: number;
	type: string;
	data: Record<string, any>;
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
}

/** Provided logger */
export type Logger = (...args: any[]) => void;

/** Factory options */
export interface JobsOptions {
	jobHandler: JobHandler;
	/** pg.Pool instance */
	pgPool: pg.Pool;
	/** Useful for non-public schema. Leave empty or provide a schema with appending dot "myschema." */
	tablePrefix?: string;
	/** Worker polling interval in milliseconds (default 1_000) */
	pollTimeoutMs?: number;
	/**  */
	logger?: Logger;
	/**  */
	gracefulSigterm?: boolean;
}

const defaultLogger = (...args: any[]) => {
	console.log(`[jobs] [${new Date().toISOString()}]`, ...args);
};

/** Core public factory api. Will create the jobs handling manager */
export function jobs(options: JobsOptions) {
	const {
		jobHandler,
		pgPool,
		pollTimeoutMs = 1_000,
		tablePrefix = "",
		logger = defaultLogger,
		gracefulSigterm = true,
	} = options || {};

	let isShuttingDown = false;
	const activeJobs = new Set();
	let workers: Promise<void>[] = [];

	const context: JobContext = {
		db: pgPool,
		tableNames: {
			tableJobs: `${tablePrefix}job`,
			tableAttempts: `${tablePrefix}job_attempt`,
		},
		logger,
	};

	//
	async function processJobs(workerId: string): Promise<void> {
		while (!isShuttingDown) {
			const job = await _claimNextJob(context);
			if (job) {
				activeJobs.add(job.id);
				try {
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

		logger?.(`Worker '${workerId}' stopped`);
	}

	// Reasonable value of concurrent workers would be 2-4
	function start(workersCount: number = 2) {
		if (isShuttingDown) {
			throw new Error(`Cannot start (shutdown in progress detected)`);
		}
		for (let i = 0; i < workersCount; i++) {
			const worker = processJobs(`worker-${i}`);
			workers.push(worker);
		}
	}

	// This is a graceful stop (will wait for all workers to finish)
	async function stop() {
		isShuttingDown = true;
		await Promise.all(workers);
		workers = [];
		isShuttingDown = false;
	}

	if (gracefulSigterm) {
		process.on("SIGTERM", async () => {
			await stop();
			process.exit(0);
		});
	}

	return {
		initialize,
		start,
		stop,
		/** Will do some maintenance cleanups. It's up to the consumer to decide the frequency. */
		cleanup() {
			return _markExpired(context);
			// todo: hard delete old?
		},
		/** Will collect some stats... */
		healthPreview(sinceHours = 1) {
			return _healhPreview(context, sinceHours);
		},
	};
}
