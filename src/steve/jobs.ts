import { createClog, type Logger } from "@marianmeres/clog";
import { createPubSub, type Unsubscriber } from "@marianmeres/pubsub";
import process from "node:process";
import type pg from "pg";
import { _claimNextJob } from "./job/_claim-next.ts";
import { _create } from "./job/_create.ts";
import { _executeJob } from "./job/_execute.ts";
import { _fetchAll, _find } from "./job/_find.ts";
import { _healthPreview } from "./job/_health-preview.ts";
import { _logAttemptFetchAll } from "./job/_log-attempt.ts";
import { _markExpired } from "./job/_mark-expired.ts";
import {
	_initialize,
	_schemaCreate,
	_schemaDrop,
	_uninstall,
} from "./job/_schema.ts";
import { pgQuoteValue } from "./utils/pg-quote.ts";
import { sleep } from "./utils/sleep.ts";
import { withDbRetry, type DbRetryOptions } from "./utils/with-db-retry.ts";
import {
	checkDbHealth,
	DbHealthMonitor,
	type DbHealthStatus,
} from "./utils/db-health.ts";

/**
 * Available job statuses.
 *
 * - `PENDING` - Job is waiting to be processed
 * - `RUNNING` - Job is currently being executed
 * - `COMPLETED` - Job finished successfully
 * - `FAILED` - Job failed after exhausting all retry attempts
 * - `EXPIRED` - Job was in running state for too long and was marked as expired
 */
export const JOB_STATUS = {
	PENDING: "pending",
	RUNNING: "running",
	COMPLETED: "completed",
	FAILED: "failed",
	EXPIRED: "expired",
} as const;

/**
 * Job attempt log statuses.
 *
 * - `SUCCESS` - Attempt completed successfully
 * - `ERROR` - Attempt failed with an error
 */
export const ATTEMPT_STATUS = {
	SUCCESS: "success",
	ERROR: "error",
} as const;

/**
 * Available backoff strategies for retry logic.
 *
 * - `NONE` - No delay between retries
 * - `EXP` - Exponential backoff with 2^attempts seconds delay
 */
export const BACKOFF_STRATEGY = {
	NONE: "none",
	EXP: "exp",
} as const;

/**
 * Job handler function type.
 *
 * A function that processes a job. The returned value will be stored in
 * the job's `result` field. Must throw an error to indicate failure.
 *
 * @param job - The job to process
 * @returns The result of the job processing, or a Promise resolving to the result
 */
export type JobHandler = (job: Job) => any | Promise<any>;

/**
 * Map of job handlers keyed by job type.
 *
 * Used to register different handlers for different job types.
 */
export type JobHandlersMap = Record<string, JobHandler | null | undefined>;

/**
 * Callback function that receives a job.
 *
 * Used for event callbacks like `onDone` and `onAttempt`.
 *
 * @param job - The job that triggered the callback
 * @returns Any value or a Promise
 */
export type JobAwareFn = (job: Job) => any | Promise<any>;

/**
 * Internal context passed to job utilities.
 * @internal
 */
export interface JobContext {
	/** PostgreSQL database connection pool or client */
	db: pg.Pool | pg.Client;
	/** Table name configuration */
	tableNames: {
		tableJobs: string;
		tableAttempts: string;
	};
	/** Logger instance */
	logger: Logger;
	/** PubSub instance for attempt events */
	pubsubAttempt: ReturnType<typeof createPubSub>;
	/** PubSub instance for done events */
	pubsubDone: ReturnType<typeof createPubSub>;
	/** Callbacks for specific job UID completion */
	onDoneCallbacks: Map<string, Set<JobAwareFn>>;
	/** Callbacks for specific job UID attempts */
	onAttemptCallbacks: Map<string, Set<JobAwareFn>>;
}

/**
 * Represents a job row in the database.
 *
 * Contains all information about a job including its current status,
 * payload, result, and timing information.
 */
export interface Job {
	/** Internal database ID */
	id: number;
	/** Unique identifier for the job (UUID) */
	uid: string;
	/** Job type identifier used to route to the appropriate handler */
	type: string;
	/** Custom payload data passed when creating the job */
	payload: Record<string, any>;
	/** Result returned by the job handler on successful completion */
	result: null | undefined | Record<string, any>;
	/** Current status of the job */
	status:
		| typeof JOB_STATUS.PENDING
		| typeof JOB_STATUS.RUNNING
		| typeof JOB_STATUS.COMPLETED
		| typeof JOB_STATUS.FAILED;
	/** Number of execution attempts made */
	attempts: number;
	/** Maximum number of attempts before marking as failed */
	max_attempts: number;
	/** Maximum allowed duration for a single attempt in milliseconds (0 = no limit) */
	max_attempt_duration_ms: number;
	/** Timestamp when the job was created */
	created_at: Date;
	/** Timestamp when the job was last updated */
	updated_at: Date;
	/** Timestamp when the job started execution */
	started_at: Date;
	/** Timestamp when the job completed (success or failure) */
	completed_at: Date;
	/** Scheduled time for the job to run (for delayed jobs) */
	run_at: Date;
	/** Backoff strategy used between retry attempts */
	backoff_strategy: typeof BACKOFF_STRATEGY.NONE | typeof BACKOFF_STRATEGY.EXP;
}

/**
 * Represents a job attempt log entry.
 *
 * Each execution attempt of a job is logged with its status,
 * timing, and error details if applicable.
 */
export interface JobAttempt {
	/** Internal database ID */
	id: number;
	/** Reference to the parent job ID */
	job_id: string;
	/** Sequential number of this attempt (1-based) */
	attempt_number: number;
	/** Timestamp when the attempt started */
	started_at: Date;
	/** Timestamp when the attempt completed */
	completed_at: Date;
	/** Status of the attempt */
	status: typeof ATTEMPT_STATUS.SUCCESS | typeof ATTEMPT_STATUS.ERROR;
	/** Error message if the attempt failed */
	error_message: null | string;
	/** Additional error details including stack trace */
	error_details: null | Record<"stack" | string, any>;
}

/**
 * Options for creating a new job.
 *
 * All fields are optional and have sensible defaults.
 */
export interface JobCreateOptions {
	/** Maximum number of retry attempts before giving up (default: 3) */
	max_attempts?: number;
	/** Maximum allowed duration for a single attempt in ms, 0 = no limit (default: 0) */
	max_attempt_duration_ms?: number;
	/** Backoff strategy between retries (default: 'exp') */
	backoff_strategy?: typeof BACKOFF_STRATEGY.NONE | typeof BACKOFF_STRATEGY.EXP;
	/** Schedule the job to run at a specific time in the future */
	run_at?: Date;
}

/**
 * Data transfer object for creating a new job.
 *
 * Extends {@link JobCreateOptions} with required type and payload fields.
 */
export interface JobCreateDTO extends JobCreateOptions {
	/** Job type identifier used to route to the appropriate handler */
	type: string;
	/** Custom payload data for the job */
	payload: Record<string, any>;
}

/**
 * Configuration options for the Jobs manager.
 *
 * @example
 * ```typescript
 * const jobs = new Jobs({
 *   db: pgPool,
 *   jobHandler: async (job) => { ... },
 *   pollTimeoutMs: 2000,
 *   dbRetry: true,
 *   dbHealthCheck: true,
 * });
 * ```
 */
export interface JobsOptions {
	/** Global job handler function for all job types */
	jobHandler?: JobHandler;
	/** Map of handlers keyed by job type (takes priority over jobHandler) */
	jobHandlers?: JobHandlersMap;
	/** PostgreSQL connection pool or client instance */
	db: pg.Pool | pg.Client;
	/** Table name prefix for non-public schemas (e.g., "myschema.") */
	tablePrefix?: string;
	/** Polling interval in milliseconds when no jobs are available (default: 1000) */
	pollTimeoutMs?: number;
	/** Logger instance for debug and error output */
	logger?: Logger;
	/** Enable SIGTERM listener for graceful shutdown (default: true) */
	gracefulSigterm?: boolean;
	/** Enable database retry on transient failures (true = defaults, or provide options) */
	dbRetry?: DbRetryOptions | boolean;
	/** Enable database health monitoring (true = defaults, or provide options) */
	dbHealthCheck?:
		| boolean
		| {
				/** Health check interval in milliseconds (default: 30000) */
				intervalMs?: number;
				/** Callback when database becomes unhealthy */
				onUnhealthy?: (status: DbHealthStatus) => void;
				/** Callback when database recovers */
				onHealthy?: (status: DbHealthStatus) => void;
		  };
}

/**
 * Creates table name configuration with optional prefix.
 * @internal
 */
function tableNames(tablePrefix: string = ""): JobContext["tableNames"] {
	return {
		tableJobs: `${tablePrefix}__job`,
		tableAttempts: `${tablePrefix}__job_attempt_log`,
	};
}

/**
 * PostgreSQL-based job processing manager.
 *
 * The Jobs class provides a complete solution for managing background jobs with
 * support for concurrent workers, automatic retries, exponential backoff,
 * job scheduling, and comprehensive event handling.
 *
 * @example
 * ```typescript
 * import { Jobs } from "@marianmeres/steve";
 *
 * const jobs = new Jobs({
 *   db: pgPool,
 *   jobHandler: async (job) => {
 *     console.log(`Processing job ${job.uid}`);
 *     return { processed: true };
 *   },
 * });
 *
 * // Start processing with 2 concurrent workers
 * await jobs.start(2);
 *
 * // Create a new job
 * const job = await jobs.create("email", { to: "user@example.com" });
 *
 * // Listen for job completion
 * jobs.onDone("email", (job) => {
 *   console.log(`Job ${job.uid} completed with status: ${job.status}`);
 * });
 *
 * // Graceful shutdown
 * await jobs.stop();
 * ```
 */
export class Jobs {
	readonly pollTimeoutMs: number;
	readonly gracefulSigterm: boolean;
	readonly tablePrefix: string;

	#db: pg.Pool | pg.Client;
	#jobHandler: JobHandler | undefined;
	#jobHandlers: JobHandlersMap;
	#logger: Logger;
	#onDoneCallbacks: Map<string, Set<JobAwareFn>> = new Map();
	#onAttemptCallbacks: Map<string, Set<JobAwareFn>> = new Map();
	#pubsubAttempt: ReturnType<typeof createPubSub> = createPubSub();
	#pubsubDone: ReturnType<typeof createPubSub> = createPubSub();
	#context: JobContext;

	#isShuttingDown = false;
	#wasInitialized = false;
	#activeJobs = new Set();
	#jobProcessors: Promise<void>[] = [];

	// event handlers try/catch wraps (they will be triggered outside of typical request handlers...)
	static #onEventWraps = new Map<CallableFunction, CallableFunction>();

	// so we don't spam the log...
	#jobClaimErrorCounter: number = 0;

	// database retry and health monitoring
	#dbRetryOptions: DbRetryOptions | null = null;
	#healthMonitor: DbHealthMonitor | null = null;

	constructor(options: JobsOptions) {
		const {
			jobHandler,
			jobHandlers = {},
			db,
			pollTimeoutMs = 1_000,
			tablePrefix = "",
			logger = createClog("jobs"),
			gracefulSigterm = true,
			dbRetry,
			dbHealthCheck,
		} = options || {};

		this.#db = db;
		this.#jobHandler = jobHandler;
		this.#jobHandlers = jobHandlers;
		this.#logger = logger;
		this.pollTimeoutMs = pollTimeoutMs;
		this.tablePrefix = tablePrefix;
		this.gracefulSigterm = gracefulSigterm;

		// Setup retry options
		if (dbRetry) {
			this.#dbRetryOptions =
				dbRetry === true
					? { logger: this.#logger }
					: { ...dbRetry, logger: this.#logger };
		}

		// Setup health monitor
		if (dbHealthCheck) {
			const healthOptions =
				dbHealthCheck === true
					? { logger: this.#logger }
					: { ...dbHealthCheck, logger: this.#logger };

			this.#healthMonitor = new DbHealthMonitor(this.#db, healthOptions);
		}

		this.#context = {
			db: this.#db,
			tableNames: tableNames(tablePrefix),
			logger: this.#logger,
			pubsubDone: this.#pubsubDone,
			pubsubAttempt: this.#pubsubAttempt,
			onDoneCallbacks: this.#onDoneCallbacks,
			onAttemptCallbacks: this.#onAttemptCallbacks,
		};
	}

	/** Wrapper for database operations with retry */
	async #withRetry<T>(fn: () => Promise<T>): Promise<T> {
		if (this.#dbRetryOptions) {
			return await withDbRetry(fn, this.#dbRetryOptions);
		}
		return await fn();
	}

	async #initializeOnce(hard?: boolean | undefined) {
		if (!this.#wasInitialized) {
			await _initialize(this.#context, !!hard);
			this.#wasInitialized = true;
			this.#logger?.debug?.(`System initialized${hard ? " (hard)" : ""} `);

			if (this.gracefulSigterm) {
				process.on("SIGTERM", async () => {
					this.#logger?.debug?.(`SIGTERM detected...`);
					await this.stop();
					// not calling the exit here... this should be a responsibility of the consumer
					// process.exit(0);
				});
			}
		}
	}

	async #processJobs(processorId: string): Promise<void> {
		const noopHandler = (_job: Job) => ({ noop: true });

		// this is to prevent log spam... note that this is not used in a "job execution" failure,
		// but only in "job claiming" failures, which should be mostly if db is unaccessible or similar...
		// "JOB CLAIM ERROR REPORTING LIMIT"
		const limit = 10;

		while (!this.#isShuttingDown) {
			try {
				const job = await this.#withRetry(() => _claimNextJob(this.#context));
				if (job) {
					this.#activeJobs.add(job.id);
					try {
						this.#logger?.debug?.(`Executing job ${job.id}...`);
						await _executeJob(
							this.#context,
							job,
							// try handler by type, fallback to global, fallback to noop
							this.#jobHandlers[job.type] ?? this.#jobHandler ?? noopHandler
						);
					} finally {
						this.#activeJobs.delete(job.id);
					}
				} else {
					await sleep(this.pollTimeoutMs);
				}
				//
				if (this.#jobClaimErrorCounter) {
					if (this.#jobClaimErrorCounter >= limit) {
						this.#logger?.debug?.(`Job claim error reporting RESUMED...`);
					}
					this.#jobClaimErrorCounter = 0;
				}
			} catch (e: any) {
				// a little dance to prevent log spam... only allow `limit` consecutive error reports
				this.#jobClaimErrorCounter++;
				if (this.#jobClaimErrorCounter < limit) {
					this.#logger?.error?.(`Job claim: ${e?.stack ?? e}`);
				} else if (this.#jobClaimErrorCounter === limit) {
					this.#logger?.debug?.(`Job claim error reporting MUTED...`);
				} // else swallow
			}
		}

		// we are here only if there is a shutdown in progress

		if (this.#activeJobs.size > 0) {
			this.#logger?.debug?.(
				`Waiting for ${this.#activeJobs.size} jobs to complete...`
			);
			while (this.#activeJobs.size > 0) {
				await sleep(100);
			}
		}

		this.#logger?.debug?.(`Job processor "${processorId}" stopped`);
	}

	/**
	 * Checks if a handler exists for the given job type.
	 *
	 * @param type - The job type to check
	 * @returns `true` if a handler is registered for the type, `false` otherwise
	 */
	hasHandler(type: string): boolean {
		return !!this.#jobHandlers[type];
	}

	/**
	 * Registers or removes a handler for a specific job type.
	 *
	 * @param type - The job type to register the handler for
	 * @param handler - The handler function, or `null`/`undefined` to remove
	 * @returns The Jobs instance for method chaining
	 *
	 * @example
	 * ```typescript
	 * jobs.setHandler("email", async (job) => {
	 *   await sendEmail(job.payload);
	 * });
	 *
	 * // Remove handler
	 * jobs.setHandler("email", null);
	 * ```
	 */
	setHandler(type: string, handler: JobHandler | undefined | null): Jobs {
		if (typeof handler === "function") {
			this.#jobHandlers[type] = handler;
		} else {
			delete this.#jobHandlers[type];
		}
		return this;
	}

	/**
	 * Removes all registered handlers.
	 *
	 * Resets both the type-specific handlers map and the global handler.
	 */
	resetHandlers(): void {
		this.#jobHandlers = {};
		this.#jobHandler = undefined;
	}

	/**
	 * Starts job processing with the specified number of concurrent workers.
	 *
	 * Initializes the database schema if needed and spawns worker processes
	 * that continuously poll for and execute pending jobs.
	 *
	 * @param processorsCount - Number of concurrent job processors (default: 2)
	 * @returns A Promise that resolves when all processors are initialized
	 *
	 * @example
	 * ```typescript
	 * // Start with 4 concurrent workers
	 * await jobs.start(4);
	 * ```
	 */
	async start(processorsCount: number = 2): Promise<void> {
		try {
			if (this.#isShuttingDown) {
				const msg = `Cannot start (shutdown in progress detected)`;
				this.#logger?.error?.(msg);
				throw new Error(msg);
			}

			await this.#initializeOnce();

			// Start health monitor
			if (this.#healthMonitor) {
				await this.#healthMonitor.start();
				this.#logger?.debug?.("DB health monitoring started");
			}
		} catch (e) {
			this.#logger?.error?.(`Unable to start: ${e}`);
			this.#logger?.error?.(`JOBS NOT STARTED`);
			return;
		}

		for (let i = 0; i < processorsCount; i++) {
			const processorId = `job-processor-${i}`;
			const processor = this.#processJobs(processorId);
			this.#jobProcessors.push(processor);
			// this.#logger?.debug?.(`Processor '${processorId}' initialized`);
		}
		this.#logger?.debug?.(
			`Job processors initialized (count: ${processorsCount})...`
		);
	}

	/**
	 * Gracefully stops all running job processors.
	 *
	 * Waits for all currently executing jobs to complete before stopping.
	 * Also stops the health monitor if enabled.
	 *
	 * @returns A Promise that resolves when all processors have stopped
	 */
	async stop(): Promise<void> {
		// Stop health monitor
		if (this.#healthMonitor) {
			this.#healthMonitor.stop();
			this.#logger?.debug?.("DB health monitoring stopped");
		}

		this.#isShuttingDown = true;
		await Promise.all(this.#jobProcessors);
		this.#jobProcessors = [];
		this.#isShuttingDown = false;
	}

	/**
	 * Creates a new job and adds it to the processing queue.
	 *
	 * The job will be picked up by one of the worker processors based on its
	 * `run_at` time and available capacity.
	 *
	 * @param type - Job type identifier used to route to the appropriate handler
	 * @param payload - Custom data to pass to the job handler
	 * @param options - Optional configuration for retry, timeout, and scheduling
	 * @param onDone - Optional callback executed when this specific job completes
	 * @returns The created Job object with its assigned UID
	 *
	 * @example
	 * ```typescript
	 * const job = await jobs.create(
	 *   "send-email",
	 *   { to: "user@example.com", subject: "Hello" },
	 *   { max_attempts: 5, backoff_strategy: "exp" }
	 * );
	 * console.log(`Created job: ${job.uid}`);
	 * ```
	 */
	async create(
		type: string,
		payload: Record<string, any> = {},
		options?: JobCreateOptions,
		onDone?: JobAwareFn
	): Promise<Job> {
		const {
			max_attempts = 3,
			backoff_strategy = BACKOFF_STRATEGY.EXP,
			max_attempt_duration_ms = 0,
			run_at,
		} = options || {};

		await this.#initializeOnce();

		return await _create(
			this.#context,
			{
				type,
				payload,
				max_attempts,
				backoff_strategy,
				run_at,
				max_attempt_duration_ms,
			},
			onDone
		);
	}

	/**
	 * Finds a job by its unique identifier.
	 *
	 * @param uid - The unique identifier (UUID) of the job
	 * @param withAttempts - Whether to include attempt history (default: false)
	 * @returns Object containing the job and optionally its attempt history
	 *
	 * @example
	 * ```typescript
	 * const { job, attempts } = await jobs.find("abc-123", true);
	 * if (job) {
	 *   console.log(`Job status: ${job.status}`);
	 *   console.log(`Attempts: ${attempts?.length}`);
	 * }
	 * ```
	 */
	async find(
		uid: string,
		withAttempts: boolean = false
	): Promise<{ job: Job; attempts: null | JobAttempt[] }> {
		await this.#initializeOnce();
		const job = await _find(this.#context, uid);
		let attempts: null | any[] = null;

		if (job && withAttempts) {
			attempts = await _logAttemptFetchAll(this.#context, job.id);
		}

		return { job, attempts };
	}

	/**
	 * Fetches all jobs, optionally filtered by status.
	 *
	 * @param status - Filter by status (single value or array)
	 * @param options - Pagination and filtering options
	 * @param options.limit - Maximum number of jobs to return
	 * @param options.offset - Number of jobs to skip
	 * @param options.asc - Sort ascending by created_at (default: descending)
	 * @param options.sinceMinutesAgo - Only return jobs created within the last N minutes
	 * @returns Array of jobs matching the criteria
	 *
	 * @example
	 * ```typescript
	 * // Get all pending jobs
	 * const pending = await jobs.fetchAll("pending");
	 *
	 * // Get failed and expired jobs with pagination
	 * const failed = await jobs.fetchAll(["failed", "expired"], {
	 *   limit: 10,
	 *   offset: 0
	 * });
	 * ```
	 */
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

		return await _fetchAll(this.#context, where, options);
	}

	/**
	 * Performs maintenance cleanup tasks.
	 *
	 * Currently marks jobs that have been running for too long as expired.
	 * The cleanup strategy should be called periodically by the consumer.
	 *
	 * @returns A Promise that resolves when cleanup is complete
	 */
	async cleanup(): Promise<void> {
		await this.#initializeOnce();
		return await _markExpired(this.#context);
	}

	/**
	 * Collects job statistics for health monitoring.
	 *
	 * @param sinceMinutesAgo - Time window for statistics (default: 60 minutes)
	 * @returns Array of statistics grouped by status with counts and durations
	 *
	 * @example
	 * ```typescript
	 * const stats = await jobs.healthPreview(30);
	 * // Returns counts and avg durations per status
	 * ```
	 */
	async healthPreview(sinceMinutesAgo: number = 60): Promise<any[]> {
		await this.#initializeOnce();
		return await _healthPreview(this.#context, sinceMinutesAgo);
	}

	/**
	 * Reinitializes the database schema by dropping and recreating tables.
	 *
	 * **Warning:** This will delete all job data. Intended for testing only.
	 *
	 * @returns A Promise that resolves when reinitialization is complete
	 */
	async resetHard(): Promise<void> {
		return await this.#initializeOnce(true);
	}

	/**
	 * Removes all database tables created by Steve.
	 *
	 * **Warning:** This will permanently delete all job data and schema.
	 *
	 * @returns A Promise that resolves when uninstallation is complete
	 */
	async uninstall(): Promise<void> {
		return await _uninstall(this.#context);
	}

	/**
	 * Registers a callback for when a specific job completes.
	 *
	 * The callback is executed once when the job with the given UID
	 * reaches a final state (completed or failed).
	 *
	 * @param jobUid - The unique identifier of the job to watch
	 * @param cb - Callback function to execute on completion
	 */
	onDoneFor(jobUid: string, cb: (job: Job) => void): void {
		if (!this.#onDoneCallbacks.has(jobUid)) {
			this.#onDoneCallbacks.set(jobUid, new Set());
		}
		this.#onDoneCallbacks.get(jobUid)?.add(cb);
	}

	/**
	 * Registers a callback for each attempt of a specific job.
	 *
	 * The callback is executed on each attempt of the job with the given UID.
	 *
	 * @param jobUid - The unique identifier of the job to watch
	 * @param cb - Callback function to execute on each attempt
	 */
	onAttemptFor(jobUid: string, cb: (job: Job) => void): void {
		if (!this.#onAttemptCallbacks.has(jobUid)) {
			this.#onAttemptCallbacks.set(jobUid, new Set());
		}
		this.#onAttemptCallbacks.get(jobUid)?.add(cb);
	}

	/**
	 * Subscribes to job completion events for specific job types.
	 *
	 * The callback is executed when any job of the specified type(s) completes
	 * (either successfully or with failure after exhausting retries).
	 *
	 * @param type - Job type or array of types to subscribe to
	 * @param cb - Callback function to execute on job completion
	 * @param skipIfExists - Skip if callback already registered (default: true)
	 * @returns Unsubscribe function to remove the listener
	 *
	 * @example
	 * ```typescript
	 * const unsub = jobs.onDone("email", (job) => {
	 *   if (job.status === "completed") {
	 *     console.log("Email sent successfully");
	 *   }
	 * });
	 *
	 * // Later: remove the listener
	 * unsub();
	 * ```
	 */
	onDone(
		type: string | string[],
		cb: (job: Job) => void,
		skipIfExists: boolean = true
	): Unsubscriber {
		return this.#onEvent(this.#pubsubDone, type, cb, skipIfExists);
	}

	/**
	 * Subscribes to job attempt events for specific job types.
	 *
	 * The callback is executed on each attempt of jobs with the specified type(s).
	 * This includes both the start and end of each attempt.
	 *
	 * @param type - Job type or array of types to subscribe to
	 * @param cb - Callback function to execute on each attempt
	 * @param skipIfExists - Skip if callback already registered (default: true)
	 * @returns Unsubscribe function to remove the listener
	 *
	 * @example
	 * ```typescript
	 * jobs.onAttempt("email", (job) => {
	 *   console.log(`Attempt ${job.attempts} - Status: ${job.status}`);
	 * });
	 * ```
	 */
	onAttempt(
		type: string | string[],
		cb: (job: Job) => void,
		skipIfExists: boolean = true
	): Unsubscriber {
		return this.#onEvent(this.#pubsubAttempt, type, cb, skipIfExists);
	}

	/** Internal DRY helper */
	#onEvent(
		pubsub: ReturnType<typeof createPubSub>,
		type: string | string[],
		cb: (job: Job) => void,
		skipIfExists: boolean
	): Unsubscriber {
		const types = Array.isArray(type) ? type : [type];
		const unsubs: any[] = [];

		// wrap callback to make sure it will not kill the server on unhandled error
		// (the onEvent handlers will be triggered outside of typical webserver request handlers)
		if (!Jobs.#onEventWraps.has(cb)) {
			Jobs.#onEventWraps.set(cb, async (job: Job) => {
				try {
					await cb(job);
				} catch (e) {
					this.#logger?.error?.(`onEvent ${type}: ${e}`);
				}
			});
		}
		const wrapped = Jobs.#onEventWraps.get(cb) as any;

		types.forEach((t) => {
			if (!skipIfExists || !pubsub.isSubscribed(t, wrapped)) {
				const unsub = pubsub.subscribe(t, wrapped);
				unsubs.push(() => {
					unsub();
					Jobs.#onEventWraps.delete(cb);
				});
			}
		});
		return () => unsubs.forEach((u) => u());
	}

	/**
	 * Removes all event listeners.
	 *
	 * Primarily used in tests to clean up between test cases.
	 */
	unsubscribeAll(): void {
		this.#pubsubAttempt.unsubscribeAll();
		this.#pubsubDone.unsubscribeAll();
	}

	/**
	 * Gets the current database health status.
	 *
	 * @returns The last health check status, or `null` if monitoring is not enabled
	 */
	getDbHealth(): DbHealthStatus | null {
		return this.#healthMonitor?.getLastStatus() ?? null;
	}

	/**
	 * Manually triggers a database health check.
	 *
	 * @returns The current health status
	 */
	async checkDbHealth(): Promise<DbHealthStatus> {
		return await checkDbHealth(this.#db, this.#logger);
	}

	/**
	 * Dumps internal state for debugging purposes.
	 * @internal
	 */
	__debugDump(): {
		pubsubAttempt: ReturnType<ReturnType<typeof createPubSub>["__dump"]>;
		pubsubDone: ReturnType<ReturnType<typeof createPubSub>["__dump"]>;
		onDoneCallbacks: Record<string, Set<JobAwareFn>>;
		onAttemptCallbacks: Record<string, Set<JobAwareFn>>;
	} {
		return {
			pubsubAttempt: this.#pubsubAttempt.__dump(),
			pubsubDone: this.#pubsubDone.__dump(),
			onDoneCallbacks: Object.fromEntries(this.#onDoneCallbacks.entries()),
			onAttemptCallbacks: Object.fromEntries(
				this.#onAttemptCallbacks.entries()
			),
		};
	}

	/**
	 * Returns raw SQL for schema operations.
	 * @internal
	 */
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
