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
  - [JobHandler](#jobhandler)
  - [JobAwareFn](#jobawarefn)
- [Constants](#constants)
  - [JOB_STATUS](#job_status)
  - [ATTEMPT_STATUS](#attempt_status)
  - [BACKOFF_STRATEGY](#backoff_strategy)
- [Database Utilities](#database-utilities)
  - [withDbRetry](#withdbretry)
  - [checkDbHealth](#checkdbhealth)
  - [DbHealthMonitor](#dbhealthmonitor)
  - [DbRetryOptions](#dbretryoptions)
  - [DbHealthStatus](#dbhealthstatus)

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

**Example:**
```typescript
await jobs.start(4); // Start with 4 concurrent workers
```

---

#### stop

```typescript
async stop(): Promise<void>
```

Gracefully stops all running job processors. Waits for currently executing jobs to complete.

---

#### create

```typescript
async create(
  type: string,
  payload?: Record<string, any>,
  options?: JobCreateOptions,
  onDone?: JobAwareFn
): Promise<Job>
```

Creates a new job and adds it to the processing queue.

**Parameters:**
- `type` - Job type identifier used to route to the appropriate handler
- `payload` - Custom data to pass to the job handler (default: `{}`)
- `options` - Configuration for retry, timeout, and scheduling (see [JobCreateOptions](#jobcreateoptions))
- `onDone` - Callback executed when this specific job completes

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
  withAttempts?: boolean
): Promise<{ job: Job; attempts: null | JobAttempt[] }>
```

Finds a job by its unique identifier.

**Parameters:**
- `uid` - The unique identifier (UUID) of the job
- `withAttempts` - Whether to include attempt history (default: `false`)

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

Subscribes to job attempt events for specific job types. The callback is executed on each attempt (both start and end).

---

#### onDoneFor

```typescript
onDoneFor(jobUid: string, cb: (job: Job) => void): void
```

Registers a callback for when a specific job completes.

---

#### onAttemptFor

```typescript
onAttemptFor(jobUid: string, cb: (job: Job) => void): void
```

Registers a callback for each attempt of a specific job.

---

#### cleanup

```typescript
async cleanup(): Promise<void>
```

Performs maintenance cleanup tasks. Marks jobs that have been running too long as expired.

---

#### healthPreview

```typescript
async healthPreview(sinceMinutesAgo?: number): Promise<any[]>
```

Collects job statistics for health monitoring.

**Parameters:**
- `sinceMinutesAgo` - Time window for statistics (default: `60`)

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

Manually triggers a database health check.

---

#### resetHard

```typescript
async resetHard(): Promise<void>
```

Reinitializes the database schema by dropping and recreating tables.

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

Removes all event listeners. Primarily used in tests.

---

### Properties

| Property | Type | Description |
|----------|------|-------------|
| `pollTimeoutMs` | `number` | Polling interval in ms (readonly) |
| `gracefulSigterm` | `boolean` | Whether SIGTERM handling is enabled (readonly) |
| `tablePrefix` | `string` | Table name prefix (readonly) |

---

## Types and Interfaces

### Job

Represents a job row in the database.

```typescript
interface Job {
  id: number;                    // Internal database ID
  uid: string;                   // Unique identifier (UUID)
  type: string;                  // Job type identifier
  payload: Record<string, any>;  // Custom payload data
  result: null | undefined | Record<string, any>;  // Handler result
  status: "pending" | "running" | "completed" | "failed" | "expired";
  attempts: number;              // Number of attempts made
  max_attempts: number;          // Maximum retry attempts
  max_attempt_duration_ms: number;  // Max attempt duration (0 = no limit)
  created_at: Date;
  updated_at: Date;
  started_at: Date;
  completed_at: Date;
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
  error_details: null | Record<string, any>;  // Includes stack trace
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
}
```

---

### JobsOptions

Configuration options for the Jobs manager.

```typescript
interface JobsOptions {
  db: pg.Pool | pg.Client;       // PostgreSQL connection (required)
  jobHandler?: JobHandler;       // Global job handler
  jobHandlers?: JobHandlersMap;  // Map of handlers by type
  tablePrefix?: string;          // Table name prefix (e.g., "myschema.")
  pollTimeoutMs?: number;        // Polling interval (default: 1000)
  logger?: Logger;               // Logger instance
  gracefulSigterm?: boolean;     // Enable SIGTERM handling (default: true)
  dbRetry?: DbRetryOptions | boolean;  // Enable retry on transient failures
  dbHealthCheck?: boolean | {    // Enable health monitoring
    intervalMs?: number;
    onUnhealthy?: (status: DbHealthStatus) => void;
    onHealthy?: (status: DbHealthStatus) => void;
  };
}
```

---

### JobHandler

```typescript
type JobHandler = (job: Job) => any | Promise<any>;
```

A function that processes a job. The returned value is stored in the job's `result` field. Must throw an error to indicate failure.

---

### JobAwareFn

```typescript
type JobAwareFn = (job: Job) => any | Promise<any>;
```

Callback function that receives a job. Used for event callbacks like `onDone` and `onAttempt`.

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
  EXP: "exp",    // Exponential backoff (2^attempts seconds)
} as const;
```

---

## Database Utilities

### withDbRetry

```typescript
async function withDbRetry<T>(
  fn: () => Promise<T>,
  options?: DbRetryOptions
): Promise<T>
```

Wraps a database operation with exponential backoff retry logic. Automatically retries on transient database errors.

**Example:**
```typescript
const result = await withDbRetry(
  async () => await db.query("SELECT * FROM users"),
  { maxRetries: 5, initialDelayMs: 200 }
);
```

---

### checkDbHealth

```typescript
async function checkDbHealth(
  db: pg.Pool | pg.Client,
  logger?: Logger
): Promise<DbHealthStatus>
```

Performs a one-time health check against the database. Measures latency and retrieves PostgreSQL version.

---

### DbHealthMonitor

Periodic database health monitor with state change callbacks.

```typescript
class DbHealthMonitor {
  constructor(db: pg.Pool | pg.Client, options?: {
    intervalMs?: number;
    logger?: Logger;
    onUnhealthy?: (status: DbHealthStatus) => void;
    onHealthy?: (status: DbHealthStatus) => void;
  });

  async start(): Promise<void>;
  stop(): void;
  getLastStatus(): DbHealthStatus | null;
}
```

**Example:**
```typescript
const monitor = new DbHealthMonitor(pool, {
  intervalMs: 30000,
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
  maxRetries?: number;        // Default: 3
  initialDelayMs?: number;    // Default: 100
  maxDelayMs?: number;        // Default: 5000
  backoffMultiplier?: number; // Default: 2
  retryableErrors?: string[]; // Error codes to retry
  logger?: Logger;
}
```

**Default Retryable Errors:**
- `ECONNREFUSED`, `ECONNRESET`, `ETIMEDOUT`, `ENOTFOUND`
- PostgreSQL: `57P03`, `08006`, `08003`, `08000`

---

### DbHealthStatus

```typescript
interface DbHealthStatus {
  healthy: boolean;
  latencyMs: number | null;
  error: string | null;
  timestamp: Date;
  pgVersion?: string;
}
```
