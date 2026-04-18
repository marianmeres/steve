# @marianmeres/steve — Agent Guide

## Quick Reference

- **Stack**: Deno/Node.js, PostgreSQL, pg driver
- **Run**: `deno task example` | **Test**: `deno task test` | **Build**: `deno task npm:build`

## Package Overview

- **Name**: `@marianmeres/steve`
- **Type**: PostgreSQL job queue/processing library
- **Runtime**: Deno and Node.js
- **Version**: 2.0.0
- **License**: MIT

## Purpose

Steve is a PostgreSQL-based job processing manager that provides:
- Distributed job queue with multiple concurrent workers (`FOR UPDATE SKIP LOCKED`)
- Automatic retry with configurable exponential backoff (capped at 1 hour)
- Job scheduling (delayed execution via `run_at`)
- Database resilience with connection-retry logic and real, single-connection transactions
- Health monitoring with state-change callbacks
- Automatic or manual cleanup of crashed-worker-leftovers (`expired` jobs)
- AbortSignal-based cooperative timeouts
- Audit trail via attempt logging

## Architecture

```
src/
├── mod.ts                  # Main entry point, re-exports public API
└── steve/
    ├── jobs.ts             # Main Jobs class and public types
    ├── job/                # Internal job operations
    │   ├── _schema.ts      # Database schema creation/teardown (transactional)
    │   ├── _create.ts      # Job creation (validates run_at)
    │   ├── _claim-next.ts  # Atomic job claiming (ORDER BY run_at, id)
    │   ├── _execute.ts     # Job execution orchestration (retry-wrapped finalization)
    │   ├── _handle-success.ts  # Transactional success finalization
    │   ├── _handle-failure.ts  # Transactional failure finalization (backoff cap)
    │   ├── _find.ts        # Job querying (sinceMinutesAgo parameterized)
    │   ├── _log-attempt.ts # Attempt logging (accepts client-or-pool)
    │   ├── _mark-expired.ts  # Reaper; returns affected rows
    │   └── _health-preview.ts
    └── utils/
        ├── with-db-retry.ts    # Retry with exponential backoff
        ├── db-health.ts        # Health checking/monitoring
        ├── with-transaction.ts # Acquires a dedicated client for BEGIN/COMMIT/ROLLBACK
        ├── sleep.ts            # Promise-based delay
        ├── pg-quote.ts         # SQL escaping (limited; status-filter only)
        └── with-timeout.ts     # AbortSignal-aware timeout wrapper
```

## Before Making Changes

- [ ] Check existing patterns in `src/steve/job/` for job operations
- [ ] Transactional writes MUST go through `withTransaction` — never `pool.query("BEGIN")` (each pool.query can grab a different connection)
- [ ] Run tests: `deno task test`
- [ ] Ensure PostgreSQL test database is available (see `.env.example`)

## Public API Exports

From `src/mod.ts`:

### Classes
- `Jobs` - Main job manager class
- `DbHealthMonitor` - Periodic DB health monitor (re-exported)

### Functions
- `withDbRetry<T>(fn, options?)` - Wraps async function with retry logic
- `checkDbHealth(db, logger?)` - One-time database health check

### Interfaces
- `Job` - Job row representation (`status` union includes `"expired"`)
- `JobAttempt` - Attempt log entry
- `JobCreateOptions` - Options for creating jobs
- `JobCreateDTO` - DTO extending JobCreateOptions with type and payload
- `JobsOptions` - Jobs constructor options (`autoCleanup?` added)
- `AutoCleanupOptions` - Reaper configuration
- `JobContext` - Internal context (exported but internal use; now exposes `withRetry`)
- `HealthPreviewRow` - Row returned by health preview query
- `DbRetryOptions` - Retry configuration
- `DbHealthStatus` - Health check result

### Types
- `JobHandler` - `(job: Job, signal?: AbortSignal) => unknown | Promise<unknown>`
- `JobHandlersMap` - `Record<string, JobHandler | null | undefined>`
- `JobAwareFn` - `(job: Job) => void | Promise<void>`

### Constants
- `JOB_STATUS` - `{ PENDING, RUNNING, COMPLETED, FAILED, EXPIRED }`
- `ATTEMPT_STATUS` - `{ SUCCESS, ERROR }`
- `BACKOFF_STRATEGY` - `{ NONE, EXP }`

## Database Schema

Two tables are created (with configurable prefix). Schema uses `CREATE TABLE IF NOT EXISTS`; there is NO schema migration across Steve versions yet — breaking column changes require manual migration.

### `__job`
| Column | Type | Description |
|--------|------|-------------|
| id | SERIAL | Primary key |
| uid | UUID | Unique identifier |
| type | VARCHAR | Job type for routing |
| payload | JSONB | Custom job data |
| result | JSONB | Handler return value |
| status | VARCHAR | pending/running/completed/failed/expired |
| attempts | INT | Attempt count (1-based after claim) |
| max_attempts | INT | Max retry attempts |
| max_attempt_duration_ms | INT | Timeout per attempt (0 = unlimited) |
| backoff_strategy | VARCHAR | none/exp |
| created_at | TIMESTAMPTZ | Creation time |
| updated_at | TIMESTAMPTZ | Last update |
| started_at | TIMESTAMPTZ | First execution start (preserved across retries via COALESCE) |
| completed_at | TIMESTAMPTZ | Final completion (set for completed, failed, AND expired) |
| run_at | TIMESTAMPTZ | Scheduled execution time |

### `__job_attempt_log`
| Column | Type | Description |
|--------|------|-------------|
| id | SERIAL | Primary key |
| job_id | INT | Foreign key to __job (ON DELETE CASCADE) |
| attempt_number | INT | Sequential attempt number |
| started_at | TIMESTAMPTZ | Attempt start |
| completed_at | TIMESTAMPTZ | Attempt end |
| status | VARCHAR | success/error |
| error_message | TEXT | Error message if failed |
| error_details | JSONB | Full error with stack trace |

## Key Behaviors

### Job Claiming
- Uses `FOR UPDATE SKIP LOCKED` for atomic claiming across workers
- `ORDER BY run_at, id` — fair for mixed scheduled/immediate jobs
- `started_at` is set with `COALESCE(started_at, NOW())` → preserved across retries
- Poll sleep is jittered ±25% to avoid thundering herd

### Transactions
- `_handleJobSuccess`, `_handleJobFailure`, `_initialize`, `_uninstall` all use `withTransaction()`
- `withTransaction` acquires a dedicated pool client, runs BEGIN + work + COMMIT on that client, and ROLLBACK on error
- **Never use `pool.query("BEGIN")`** for transactional code — pool.query can acquire a different connection per call

### Retry Logic
- Default: 3 attempts with exponential backoff
- Formula: `min(2^attempts × 1000ms, 1 hour)` (capped)
- Configurable via `max_attempts` and `backoff_strategy`
- `dbRetry` option wraps every DB call (claim, create, find, handlers, cleanup) with transient-error retry

### Timeouts & AbortSignal
- When `max_attempt_duration_ms > 0`, the handler receives an `AbortSignal` as its second arg
- On timeout: the attempt is recorded as failed AND `signal.abort()` fires
- Cooperative handlers should check `signal.aborted` or attach listeners to bail early
- JavaScript cannot forcibly kill a running Promise — handlers that ignore the signal keep running in the background

### Job Status Flow
```
PENDING → RUNNING → COMPLETED
                  ↘ PENDING (retry with backoff)
                  ↘ FAILED (max attempts reached)
                  ↘ EXPIRED (via cleanup() / autoCleanup)
```

### Cleanup / Expired Reaper
- `jobs.cleanup(maxMinutes?)` marks stuck-`running` rows as `expired`, sets `completed_at`, and fires `onDone` for each
- Pass `autoCleanup: true` (or a config) to run the reaper automatically on a timer (default: every 60s, threshold 5min)
- Expired status is terminal (no auto-retry) — work may be stale by the time we notice

### Graceful Shutdown
- `start()` is idempotent (second call is a no-op with a warning) and THROWS on init failure
- SIGTERM handler is added on `start()` and removed on `stop()` (no listener leak across instances)
- `stop()` awaits currently-running jobs before returning

### Events
- `#onEventWraps` is per-instance and keyed by `(type, cb)` — safe for callbacks shared across Jobs instances and for multi-type subscribe+unsubscribe
- `unsubscribeAll()` clears both the pubsubs AND the internal wrap registry

## Dependencies

- `pg` - PostgreSQL driver
- `@marianmeres/clog` - Logger
- `@marianmeres/pubsub` - Event system
- `@marianmeres/data-to-sql-params` - SQL parameter builder
- `@marianmeres/parse-boolean` - Used for `asc` flag coercion

## Testing

```bash
deno task test
```

Requires PostgreSQL with credentials in `.env` file:
```
TEST_PG_HOST=localhost
TEST_PG_DATABASE=test
TEST_PG_USER=test
TEST_PG_PASSWORD=test
TEST_PG_PORT=5432
```

Test files:
- `tests/jobs.test.ts` — core Jobs class behavior
- `tests/db-resilience.test.ts` — retry and health monitor
- `tests/fixes.test.ts` — regression guards for v2.0.0 fixes (transactions, injection, event isolation, lifecycle, reaper, AbortSignal, backoff cap, etc.)

## Common Patterns

### Basic Usage
```typescript
const jobs = new Jobs({
  db: pgPool,
  jobHandler: async (job, signal) => {
    // respect signal for best behavior under max_attempt_duration_ms
    if (signal?.aborted) return;
    // process...
  },
  autoCleanup: true,   // reap stuck-running jobs automatically
  dbRetry: true,       // retry transient DB failures
});
await jobs.start(2);
await jobs.create("type", { data: true });
```

### Type-Specific Handlers
```typescript
const jobs = new Jobs({
  db: pgPool,
  jobHandlers: {
    email: async (job) => sendEmail(job.payload),
    sms: async (job) => sendSms(job.payload),
  },
});
```

### Event Listening
```typescript
jobs.onDone("email", (job) => {
  // fires for completed, failed (terminal), OR expired (via cleanup)
  switch (job.status) {
    case "completed": /* success */ break;
    case "failed":    /* all retries exhausted */ break;
    case "expired":   /* worker probably crashed */ break;
  }
});

jobs.onAttempt("email", (job) => {
  // fires on every state transition: running, completed/failed/pending
  console.log(`Attempt ${job.attempts}: ${job.status}`);
});
```

### Health Monitoring
```typescript
const jobs = new Jobs({
  db: pgPool,
  dbRetry: true,
  dbHealthCheck: {
    intervalMs: 30000,
    onUnhealthy: (status) => alert(status.error),
    onHealthy: () => clearAlert(),
  },
});
```

## File Locations

| Purpose | Path |
|---------|------|
| Main entry | `src/mod.ts` |
| Jobs class | `src/steve/jobs.ts` |
| Retry utility | `src/steve/utils/with-db-retry.ts` |
| Transaction utility | `src/steve/utils/with-transaction.ts` |
| Health utility | `src/steve/utils/db-health.ts` |
| Timeout/AbortSignal | `src/steve/utils/with-timeout.ts` |
| Tests | `tests/jobs.test.ts`, `tests/db-resilience.test.ts`, `tests/fixes.test.ts` |
| Example server | `example/server.ts` |
| Config | `deno.json` |
