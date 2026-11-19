# API Reference

Complete API documentation for `@marianmeres/steve`.

## Table of Contents

- [Jobs Class](#jobs-class)
  - [Constructor](#constructor)
  - [Methods](#methods)
  - [Properties](#properties)
- [Types and Interfaces](#types-and-interfaces)
  - [Job](#job)
  - [JobAttempt](#jobattempt)
  - [JobCreateOptions](#jobcreateoptions)
  - [JobsOptions](#jobsoptions)
  - [AutoCleanupOptions](#autocleanupoptions)
  - [JobHandler](#jobhandler)
  - [JobAwareFn](#jobawarefn)
  - [JobCreateDTO](#jobcreatedto)
  - [HealthPreviewRow](#healthpreviewrow)
- [Constants](#constants)
  - [JOB_STATUS](#job_status)
  - [ATTEMPT_STATUS](#attempt_status)
  - [BACKOFF_STRATEGY](#backoff_strategy)
- [Database Utilities](#database-utilities)
  - [withDbRetry](#withdbretry)
  - [checkDbHealth](#checkdbhealth-1)
  - [DbHealthMonitor](#dbhealthmonitor)
  - [DbRetryOptions](#dbretryoptions)
  - [DbHealthStatus](#dbhealthstatus)
- [Errors](#errors)

---

## Jobs Class

The main job processing manager.

### Constructor

```typescript
new Jobs(options: JobsOptions)
```

Creates a new Jobs instance.

**Parameters:**
- `options` - Configuration object (see [JobsOptions](#jobsoptions))

**Throws:** `TypeError` when `db` is not a `pg.Pool`, a `pg.Client` or a sqlkit `Driver`, when it is a `Driver` whose dialect is not `pg`, or when a `dbHealthCheck` option is out of range. Nothing is sent to the database before the first call that needs it.

**Example:**
```typescript
import { Jobs } from "@marianmeres/steve";

const jobs = new Jobs({
  db: pgPool,
  jobHandler: async (job) => {
    console.log(`Processing job ${job.uid}`);
    return { processed: true };
  },
  pollTimeoutMs: 1000,
  dbRetry: true,
  dbHealthCheck: true,
});
```

### Methods

#### start

```typescript
async start(processorsCount?: number): Promise<void>
```

Starts job processing with the specified number of concurrent workers.

**Parameters:**
- `processorsCount` - Number of concurrent job processors (default: `2`)

**Behavior:**
- **Throws** if initialization fails (e.g., database unreachable) so callers can fail fast.
- **Any `processorsCount` works on any `db`.** On a single connection (a `pg.Client`, or a `Driver` over one) every statement takes its turn, so handlers overlap but database work does not. A `pg.Pool` is still the recommendation.
- **Idempotent** — calling `start()` while already running is a no-op with a warning log; it will NOT spawn additional processors. To restart, call `stop()` first.

**Example:**
```typescript
await jobs.start(4); // Start with 4 concurrent workers
```

---

#### stop

```typescript
async stop(): Promise<void>
```

Gracefully stops all running job processors. Waits for currently executing jobs to complete (and for an in-flight auto-cleanup tick), stops the health monitor and auto-cleanup loop, and removes the SIGTERM listener.

When `stop()` was triggered by the built-in `SIGTERM` handler (`gracefulSigterm: true`), Steve re-raises `SIGTERM` afterwards if no other `SIGTERM` listener exists, so the process terminates as it would have without Steve. Consumers with their own `SIGTERM` handler own the exit.

---

#### create

```typescript
async create(
  type: string,
  payload?: Record<string, unknown>,
  options?: JobCreateOptions,
  onDone?: JobAwareFn
): Promise<Job>
```

Creates a new job and adds it to the processing queue.

**Parameters:**
- `type` - Job type identifier used to route to the appropriate handler
- `payload` - Custom data to pass to the job handler (default: `{}`)
- `options` - Configuration for retry, timeout, scheduling, and the optional `tenant_id` tag (see [JobCreateOptions](#jobcreateoptions))
- `onDone` - Callback executed when this specific job completes. **In-process only**: fires only if a processor of this instance executes the job. Errors thrown or rejected by it are logged and never affect the job.

**Returns:** The created `Job` object with its assigned UID

**Example:**
```typescript
const job = await jobs.create(
  "send-email",
  { to: "user@example.com", subject: "Hello" },
  { max_attempts: 5, backoff_strategy: "exp" }
);
console.log(`Created job: ${job.uid}`);
```

---

#### find

```typescript
async find(
  uid: string,
  withAttempts?: boolean,
  options?: { tenant_id?: string | null }
): Promise<{ job: Job | undefined; attempts: null | JobAttempt[] }>
```

Finds a job by its unique identifier. `job` is `undefined` when not found; a malformed (non-UUID) `uid` is reported as not-found rather than as a database error.

**Parameters:**
- `uid` - The unique identifier (UUID) of the job
- `withAttempts` - Whether to include attempt history (default: `false`)
- `options.tenant_id` - Optional tenant guard. When set, a job whose `tenant_id` does not match is reported as **not-found** (`job` is `undefined`). Since `uid` is a globally-unique UUID this is defense-in-depth, not a correctness requirement.

**Example:**
```typescript
const { job, attempts } = await jobs.find("abc-123", true);
if (job) {
  console.log(`Job status: ${job.status}`);
  console.log(`Attempts: ${attempts?.length}`);
}
```

---

#### fetchAll

```typescript
async fetchAll(
  status?: null | Job["status"] | Job["status"][],
  options?: {
    limit?: number | string;
    offset?: number | string;
    asc?: number | string | boolean;
    sinceMinutesAgo?: number;
    tenant_id?: string | string[] | null;
  }
): Promise<Job[]>
```

Fetches all jobs, optionally filtered by status.

**Parameters:**
- `status` - Filter by status (single value or array)
- `options.limit` - Maximum number of jobs to return
- `options.offset` - Number of jobs to skip
- `options.asc` - Sort ascending by created_at (default: descending)
- `options.sinceMinutesAgo` - Only return jobs created within the last N minutes
- `options.tenant_id` - Only return jobs tagged with this tenant (single value or array)

**Example:**
```typescript
// Get all pending jobs
const pending = await jobs.fetchAll("pending");

// Get failed and expired jobs with pagination
const failed = await jobs.fetchAll(["failed", "expired"], {
  limit: 10,
  offset: 0
});
```

---

#### setHandler

```typescript
setHandler(type: string, handler: JobHandler | null | undefined): Jobs
```

Registers or removes a handler for a specific job type.

**Parameters:**
- `type` - The job type to register the handler for
- `handler` - The handler function, or `null`/`undefined` to remove

**Returns:** The Jobs instance for method chaining

**Example:**
```typescript
jobs.setHandler("email", async (job) => {
  await sendEmail(job.payload);
});

// Remove handler
jobs.setHandler("email", null);
```

---

#### hasHandler

```typescript
hasHandler(type: string): boolean
```

Checks if a handler exists for the given job type.

---

#### resetHandlers

```typescript
resetHandlers(): void
```

Removes all registered handlers.

---

#### onDone

```typescript
onDone(
  type: string | string[],
  cb: (job: Job) => void,
  skipIfExists?: boolean
): Unsubscriber
```

Subscribes to job completion events for specific job types.

**In-process only**: events are published by the instance that finalizes the job (its own processors / its own `cleanup()`), not through the database. A subscriber in a process that only creates jobs never sees them. Errors thrown or rejected by the callback are logged and never affect the job.

**Parameters:**
- `type` - Job type or array of types to subscribe to
- `cb` - Callback function to execute on job completion
- `skipIfExists` - Skip if callback already registered (default: `true`)

**Returns:** Unsubscribe function to remove the listener

**Example:**
```typescript
const unsub = jobs.onDone("email", (job) => {
  if (job.status === "completed") {
    console.log("Email sent successfully");
  }
});

// Later: remove the listener
unsub();
```

---

#### onAttempt

```typescript
onAttempt(
  type: string | string[],
  cb: (job: Job) => void,
  skipIfExists?: boolean
): Unsubscriber
```

Subscribes to job attempt events for specific job types. The callback is executed on each attempt (both start and end). In-process only, errors isolated — see [onDone](#ondone).

---

#### onDoneFor

```typescript
onDoneFor(jobUid: string, cb: (job: Job) => void): void
```

Registers a callback for when a specific job completes. In-process only: fires only if this instance finalizes the job (its own processor or its own `cleanup()`); the registration lives until then or until `unsubscribeAll()`. Errors thrown or rejected by the callback are logged and never affect the job.

---

#### onAttemptFor

```typescript
onAttemptFor(jobUid: string, cb: (job: Job) => void): void
```

Registers a callback for each attempt of a specific job. In-process only, errors isolated — see [onDoneFor](#ondonefor).

---

#### cleanup

```typescript
async cleanup(
  maxAllowedRunDurationMinutes?: number,
  options?: { tenant_id?: string | string[] | null }
): Promise<number>
```

Marks jobs stuck in `running` (e.g., because a worker crashed mid-execution) as `expired`, sets `completed_at`, and publishes `onDone` events for each reaped job. Returns the number of jobs reaped.

The threshold is measured on the **current attempt** — the time the running attempt was claimed (`updated_at`) — never on `started_at` (first attempt), so a retry is not reaped because its first attempt was long ago. `expired` is final: a handler that was in fact still running finds its row no longer `running` at finalization and leaves it alone (its outcome is recorded in the attempt log only; `onDone` does not fire twice).

Called automatically when `autoCleanup` is enabled on the Jobs instance; otherwise should be called periodically by the consumer.

**Parameters:**
- `maxAllowedRunDurationMinutes` - Threshold before a `running` job is considered stuck (default: `5`)
- `options.tenant_id` - Optionally reap only the given tenant(s)' stuck jobs. Omitted reaps across **all** tenants. **Note:** `autoCleanup` always runs tenant-blind; pass this only on manual `cleanup()` calls.

**Returns:** Number of jobs reaped

**Example:**
```typescript
const reaped = await jobs.cleanup(10);
console.log(`Reaped ${reaped} stuck jobs`);
```

---

#### purge

```typescript
async purge(
  olderThanMinutes?: number,
  options?: {
    statuses?: Job["status"][];
    tenant_id?: string | string[] | null;
  }
): Promise<number>
```

Deletes terminal jobs (and, via `ON DELETE CASCADE`, their attempt-log rows) whose `completed_at` is older than `olderThanMinutes`. Nothing purges automatically — without this the job table grows without bound. Call it periodically (e.g. from a cron job).

Only terminal statuses can be purged. Passing `pending` or `running` throws a `TypeError`.

**Parameters:**
- `olderThanMinutes` - Retention window (default: `7 * 24 * 60`, i.e. 7 days)
- `options.statuses` - Which terminal statuses to purge (default: `["completed", "failed", "expired"]`)
- `options.tenant_id` - Optionally purge only the given tenant(s)' jobs

**Returns:** Number of jobs deleted

**Example:**
```typescript
// drop completed jobs older than a day, keep failures for a month
await jobs.purge(24 * 60, { statuses: ["completed"] });
await jobs.purge(30 * 24 * 60, { statuses: ["failed", "expired"] });
```

---

#### healthPreview

```typescript
async healthPreview(
  sinceMinutesAgo?: number,
  options?: { tenant_id?: string | string[] | null }
): Promise<HealthPreviewRow[]>
```

Collects job statistics for health monitoring: one row per status.

**Parameters:**
- `sinceMinutesAgo` - Time window for statistics (default: `60`)
- `options.tenant_id` - Optionally restrict the stats to one or more tenants

---

#### getDbHealth

```typescript
getDbHealth(): DbHealthStatus | null
```

Gets the current database health status.

**Returns:** The last health check status, or `null` if monitoring is not enabled

---

#### checkDbHealth

```typescript
async checkDbHealth(): Promise<DbHealthStatus>
```

Manually triggers a database health check: one `select 1`, unhealthy when it fails or has not answered within 5 s. Works whether or not `dbHealthCheck` is enabled, and never rejects for a database that is down. See [checkDbHealth](#checkdbhealth-1).

---

#### resetHard

```typescript
async resetHard(): Promise<void>
```

Reinitializes the database schema by dropping and recreating tables. Always runs, even on an already-initialized instance.

**Warning:** This will delete all job data. Intended for testing only.

---

#### uninstall

```typescript
async uninstall(): Promise<void>
```

Removes all database tables created by Steve.

**Warning:** This will permanently delete all job data and schema.

---

#### unsubscribeAll

```typescript
unsubscribeAll(): void
```

Removes all event listeners: the type-keyed `onDone` / `onAttempt` subscriptions **and** the per-job callbacks registered via `onDoneFor`, `onAttemptFor` and `create(..., onDone)`. Primarily used in tests.

---

### Properties

| Property          | Type      | Description                                    |
| ----------------- | --------- | ---------------------------------------------- |
| `pollTimeoutMs`   | `number`  | Polling interval in ms (readonly)              |
| `gracefulSigterm` | `boolean` | Whether SIGTERM handling is enabled (readonly) |
| `tablePrefix`     | `string`  | Table name prefix (readonly)                   |

---

## Types and Interfaces

### Job

Represents a job row in the database.

```typescript
interface Job {
  id: number;                    // Internal database ID
  uid: string;                   // Unique identifier (UUID)
  type: string;                  // Job type identifier
  payload: Record<string, unknown>;  // Custom payload data
  tenant_id: string | null;      // Owning tenant, or null for a global/un-scoped job
  result: null | undefined | Record<string, unknown>;  // Handler result
  status: "pending" | "running" | "completed" | "failed" | "expired";
  attempts: number;              // Number of attempts made
  max_attempts: number;          // Maximum retry attempts
  max_attempt_duration_ms: number;  // Max attempt duration (0 = no limit)
  created_at: Date;
  updated_at: Date;
  started_at: Date;              // First-attempt start (preserved across retries)
  completed_at: Date;             // Set for completed, failed, and expired
  run_at: Date;                  // Scheduled run time
  backoff_strategy: "none" | "exp";
}
```

---

### JobAttempt

Represents a job attempt log entry.

```typescript
interface JobAttempt {
  id: number;
  job_id: string;
  attempt_number: number;        // Sequential attempt number (1-based)
  started_at: Date;
  completed_at: Date;
  status: "success" | "error";
  error_message: null | string;
  error_details: null | Record<string, unknown>;  // Includes stack trace
}
```

---

### JobCreateOptions

Options for creating a new job.

```typescript
interface JobCreateOptions {
  max_attempts?: number;         // Default: 3
  max_attempt_duration_ms?: number;  // Default: 0 (no limit)
  backoff_strategy?: "none" | "exp";  // Default: "exp"
  run_at?: Date;                 // Schedule for future execution
  tenant_id?: string | null;     // Optional tenant tag; omit/null/"" => global (NULL). No FK.
}
```

---

### JobsOptions

Configuration options for the Jobs manager.

```typescript
interface JobsOptions {
  db: pg.Pool | pg.Client | Driver;  // PostgreSQL connection (required). pg.Pool recommended
  jobHandler?: JobHandler;       // Global job handler
  jobHandlers?: JobHandlersMap;  // Map of handlers by type
  tablePrefix?: string;          // Table name prefix (e.g., "myschema.")
  pollTimeoutMs?: number;        // Polling interval (default: 1000, ±25% jitter)
  logger?: Logger;               // Logger instance
  gracefulSigterm?: boolean;     // SIGTERM => stop(), then re-raise if no other listener (default: true)
  dbRetry?: DbRetryOptions | boolean;  // Enable retry on transient failures
  dbHealthCheck?: boolean | {    // Enable health monitoring
    intervalMs?: number;         // Default: 30000
    timeoutMs?: number;          // A check not answered by then is unhealthy. Default: 5000
    onUnhealthy?: (status: DbHealthStatus) => void;
    onHealthy?: (status: DbHealthStatus) => void;
  };
  autoCleanup?: boolean | AutoCleanupOptions;  // Periodic expired-reaper
}
```

`db` takes three forms:

- a node-postgres `pg.Pool`, the recommendation;
- a connected `pg.Client`: any number of processors works on it, but every statement takes its turn;
- a sqlkit `Driver` (from `@marianmeres/sqlkit`) of the `pg` dialect, used as it is. A driver you share with steve carries your transactions: read [The `db` option](README.md#the-db-option) before passing one.

The first two are declared by shape (sqlkit's `PgPoolLike` and `PgStandaloneClientLike`), so steve imports nothing from `pg`. Steve never closes what it is given.

---

### AutoCleanupOptions

Periodic reaper configuration for marking stuck-`running` jobs as `expired`.

```typescript
interface AutoCleanupOptions {
  intervalMs?: number;                    // Check interval (default: 60000)
  maxAllowedRunDurationMinutes?: number;  // Stuck-threshold, measured on the current attempt (default: 5)
}
```

---

### JobHandler

```typescript
type JobHandler = (job: Job, signal?: AbortSignal) => unknown | Promise<unknown>;
```

A function that processes a job. The returned value is stored in the job's `result` field. Must throw an error to indicate failure.

When `max_attempt_duration_ms > 0`, the second argument is an `AbortSignal` that fires when the attempt times out. Handlers should respect the signal for best behavior; handlers that ignore it will keep running in the background even after the attempt is recorded as timed-out (JavaScript cannot forcibly cancel a running Promise).

**Example (cooperative abort):**
```typescript
async function handler(job: Job, signal?: AbortSignal) {
  const res = await fetch(url, { signal });  // fetch respects AbortSignal
  return await res.json();
}
```

---

### JobAwareFn

```typescript
type JobAwareFn = (job: Job) => void | Promise<void>;
```

Callback function that receives a job. Used for event callbacks like `onDone` and `onAttempt`.

---

### JobCreateDTO

Data transfer object for creating a new job. Extends `JobCreateOptions` with required type and payload.

```typescript
interface JobCreateDTO extends JobCreateOptions {
  type: string;
  payload: Record<string, unknown>;
}
```

---

### HealthPreviewRow

Row returned by the health preview query.

```typescript
interface HealthPreviewRow {
  status: string;
  count: string;
  avg_duration_seconds: string | null;
}
```

The types are what node-postgres returns for `COUNT` and `AVG`. Rows are the driver's: with another driver of the `pg` dialect a value may read differently (on PGlite, `count` comes back as a number).

---

## Constants

### JOB_STATUS

```typescript
const JOB_STATUS = {
  PENDING: "pending",     // Waiting to be processed
  RUNNING: "running",     // Currently executing
  COMPLETED: "completed", // Finished successfully
  FAILED: "failed",       // Failed after exhausting retries
  EXPIRED: "expired",     // Running too long, marked expired
} as const;
```

---

### ATTEMPT_STATUS

```typescript
const ATTEMPT_STATUS = {
  SUCCESS: "success",
  ERROR: "error",
} as const;
```

---

### BACKOFF_STRATEGY

```typescript
const BACKOFF_STRATEGY = {
  NONE: "none",  // No delay between retries
  EXP: "exp",    // Exponential backoff: min(2^attempts seconds, 1 hour)
} as const;
```

---

## Database Utilities

The `db` these utilities take is the same as [`JobsOptions.db`](#jobsoptions): a `pg.Pool`, a `pg.Client` or a sqlkit `Driver` of the `pg` dialect. A pool or client gets one driver per object, shared with every `Jobs` instance over it; steve never closes it.

### withDbRetry

```typescript
async function withDbRetry<T>(
  fn: () => Promise<T>,
  options?: DbRetryOptions
): Promise<T>
```

Runs `fn`, and runs it again with exponential backoff while it rejects with a retryable error. Resolves with the first call that resolves; rejects with the last error once it is not retryable or no retry is left.

By default an error is retryable when sqlkit classifies it so (`classifyPg`), for a sqlkit `SqlError` and for a raw node-postgres error alike:

- a connection that could not be made or was lost: Node's socket codes (`ECONNREFUSED`, `ECONNRESET`, …), SQLSTATE class `08`, node-postgres's connection timeout and terminated connection;
- a server that is starting up or shutting down (`57P01`–`57P03`), or out of connections (`53300`);
- a deadlock (`40P01`), a serialization failure (`40001`), a lock not granted in time (`55P03`).

`options.retryableErrors` replaces that classification with exactly its list: an error is retried when its `code` is one of the codes, or its message contains one.

The whole function runs again, so wrap something safe to run twice: one statement, or one whole `transaction` call, never a part of a transaction.

**Throws:** `TypeError` (a rejection, before `fn` is called) when an option is of the wrong type or out of range, such as a negative or fractional `maxRetries` or a `backoffMultiplier` below 1.

**Example:**
```typescript
const result = await withDbRetry(
  async () => await pool.query("SELECT * FROM users"),
  { maxRetries: 5, initialDelayMs: 200 }
);
```

---

### checkDbHealth

```typescript
async function checkDbHealth(
  db: pg.Pool | pg.Client | Driver,
  logger?: Logger,
  options?: { timeoutMs?: number }
): Promise<DbHealthStatus>
```

Performs a one-time health check: one `select 1`, timed, raced against `timeoutMs`. A check that fails, or has not answered by then, is unhealthy with `latencyMs: null` (a timed-out query is abandoned, not cancelled). After a healthy check it also reports the PostgreSQL version, asked once per driver.

Never rejects for a database that is down; a failed check is logged through `logger.error`.

**Parameters:**
- `db` - The database (see above)
- `logger` - Optional logger for the failure message
- `options.timeoutMs` - Milliseconds after which a check that has not answered is unhealthy, above 0 (default: `5000`)

**Throws:** `TypeError` (a rejection) when `db` is not a database, or `timeoutMs` is of the wrong type or out of range.

**Example:**
```typescript
const status = await checkDbHealth(pool, logger, { timeoutMs: 2000 });
if (!status.healthy) console.error(`DB error: ${status.error}`);
```

---

### DbHealthMonitor

Periodic database health monitor with state change callbacks.

```typescript
class DbHealthMonitor {
  constructor(db: pg.Pool | pg.Client | Driver, options?: {
    intervalMs?: number;   // Default: 30000 (0 also means the default)
    timeoutMs?: number;    // Per check, as in checkDbHealth. Default: 5000
    logger?: Logger;
    onUnhealthy?: (status: DbHealthStatus) => void;
    onHealthy?: (status: DbHealthStatus) => void;
  });

  async start(): Promise<void>;
  stop(): void;
  getLastStatus(): DbHealthStatus | null;
}
```

- `start()` checks at once and resolves after that first check; the next check starts `intervalMs` after the previous one answered or timed out, so checks never overlap. Its timers never keep a process alive.
- `onUnhealthy` fires when a check is unhealthy after a healthy one, or when the first check is; `onHealthy` fires when a check is healthy after an unhealthy one. A healthy first check is no change. The monitor logs on these changes only, not on every failed check.
- `stop()` leaves no check scheduled. `getLastStatus()` is the latest status (kept across `stop()`), `null` before the first check.

**Throws:** `TypeError` at construction when `db` is not a database, or an option is of the wrong type or out of range.

**Example:**
```typescript
const monitor = new DbHealthMonitor(pool, {
  intervalMs: 30000,
  timeoutMs: 5000,
  onUnhealthy: (status) => alertOps(status.error),
  onHealthy: () => clearAlert(),
});

await monitor.start();
// Later...
monitor.stop();
```

---

### DbRetryOptions

```typescript
interface DbRetryOptions {
  maxRetries?: number;        // Retries after the first call, a non-negative integer. Default: 3
  initialDelayMs?: number;    // Wait before the first retry. Default: 100
  maxDelayMs?: number;        // Longest wait between two calls. Default: 5000
  backoffMultiplier?: number; // Each wait times this for the next, at least 1. Default: 2
  retryableErrors?: string[]; // Replaces the default classification (see withDbRetry)
  logger?: Logger;            // Warns before each retry
}
```

The wait before retry `n` is `initialDelayMs * backoffMultiplier ** (n - 1)`, at most `maxDelayMs`. With `dbRetry: true` on `Jobs`, every option has its default and the logger is the instance's.

---

### DbHealthStatus

```typescript
interface DbHealthStatus {
  healthy: boolean;
  latencyMs: number | null;  // null when the check failed or timed out; may be a fraction
  error: string | null;      // The driver's message, or the timeout's; null when healthy
  timestamp: Date;           // When the check was sent
  pgVersion?: string;        // e.g. "18.6", once known, on a healthy status
}
```

---

## Errors

A failed database call from any `Jobs` method rejects with a `SqlError` from `@marianmeres/sqlkit`, or one of its subclasses: `ConnectionError`, `DeadlockError`, `SerializationError`, `BusyError`, `UniqueViolationError`, `TransactionAbortedError`, …

- `kind` names the subclass (`"connection"`, `"deadlock"`, …). Prefer it to `instanceof`, which matches only when your app resolves the same copy of `@marianmeres/sqlkit` as steve.
- `code` is the SQLSTATE (or Node's code, such as `ECONNRESET`, for a lost socket) and `message` is the driver's message: node-postgres's for a pool or a client.
- The driver's original error is `cause`, untouched: read fields such as `detail`, `hint` or `severity` there.
- `retryable` is `true` for the kinds `dbRetry` retries by default.

A programming mistake (a `db` that is not a database, an option of the wrong type or range, `purge()` with a non-terminal status) is a `TypeError`, never wrapped. What a job handler throws is that job's failure, recorded on its attempt as it was thrown.

```typescript
try {
  await jobs.create("email", payload);
} catch (e) {
  if ((e as { kind?: string }).kind === "connection") {
    console.error("database unreachable:", (e as Error).cause);
  }
  throw e;
}
```
