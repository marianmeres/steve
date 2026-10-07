# @marianmeres/steve — Agent Guide

## Quick Reference

- **Stack**: Deno/Node.js, PostgreSQL, pg driver
- **Run**: `deno task example` | **Test**: `deno task test` | **Build**: `deno task npm:build`

## Package Overview

- **Name**: `@marianmeres/steve`
- **Type**: PostgreSQL job queue/processing library
- **Runtime**: Deno and Node.js
- **Version**: 3.0.0 (+ unreleased post-review fixes, see README "Upgrading from 3.0")
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
    │   ├── _events.ts      # Attempt/done fan-out; per-uid callbacks error-isolated
    │   ├── _execute.ts     # Job execution orchestration (try/catch covers the handler ONLY)
    │   ├── _handle-success.ts  # Transactional success finalization (fenced on status+attempts)
    │   ├── _handle-failure.ts  # Transactional failure finalization (backoff cap; fenced)
    │   ├── _find.ts        # Job querying (sinceMinutesAgo parameterized; non-UUID uid => not found)
    │   ├── _log-attempt.ts # Attempt logging (accepts client-or-pool)
    │   ├── _mark-expired.ts  # Reaper on updated_at (current attempt); returns affected rows
    │   ├── _purge.ts       # Retention: DELETE old terminal jobs (attempt log cascades)
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
- [ ] Finalization UPDATEs (`_handle-success.ts`, `_handle-failure.ts`) MUST stay fenced on `status = 'running' AND attempts = $n` — a `null` return means "someone else finalized it; leave it alone"
- [ ] In `_execute.ts` the try/catch covers the handler call ONLY; never put finalization or consumer callbacks inside it
- [ ] Consumer callbacks are invoked ONLY via `_events.ts` (`_safeInvoke`) or `#onEvent` — never call a user callback bare
- [ ] `job/_*.ts` modules are imported by `jobs.ts`: never read `JOB_STATUS` / `BACKOFF_STRATEGY` at module top level (circular-import TDZ) — only inside functions
- [ ] The reaper (`_mark-expired.ts`) measures `updated_at`, never `started_at`
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
- `Job` - Job row representation (`status` union includes `"expired"`); `find()` yields `job: Job | undefined`
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

Two tables are created (with configurable prefix). The schema is self-managed and
idempotent: `_schemaCreate` is re-run inside `withTransaction` on the first init of every
process (no migration ledger), serialized across processes by a transaction-scoped
`pg_advisory_xact_lock` (so N replicas booting on a fresh DB cannot race the
`CREATE ... IF NOT EXISTS` statements). In-process, concurrent first calls share one
`#initPromise`. Most of it is `CREATE TABLE IF NOT EXISTS`, so **breaking column changes
still require manual migration** — the ONE exception is the additive `tenant_id` column,
which self-heals onto already-deployed tables. The self-heal is a `DO` block that checks
`pg_attribute` first and only then runs `ALTER TABLE ... ADD COLUMN` — NOT a bare
`ADD COLUMN IF NOT EXISTS`, because `ALTER TABLE` takes an ACCESS EXCLUSIVE lock before it
evaluates `IF NOT EXISTS`, which on every boot would queue behind any open reader and stall
all claims behind it. The matching index is **partial** (`WHERE tenant_id IS NOT NULL`) so
a tenant-unaware deployment pays ~zero write cost. There is intentionally **no FK** on
`tenant_id` (see Tenancy below).

### `__job`
| Column | Type | Description |
|--------|------|-------------|
| id | SERIAL | Primary key |
| uid | UUID | Unique identifier |
| type | VARCHAR | Job type for routing |
| payload | JSONB | Custom job data |
| tenant_id | VARCHAR(255) | Optional, nullable audit/scoping tag. NULL = global/un-scoped. No FK. |
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
- `updated_at = NOW()` on every claim and untouched during execution → for a `running` row it is "when the CURRENT attempt started" (the reaper's reference)
- Poll sleep is jittered ±25% to avoid thundering herd
- Handler dispatch is a `Map` lookup (`#jobHandlers.get(type)`), so types like `constructor` / `__proto__` can't resolve to `Object.prototype` members

### Execution & Finalization (`_execute.ts`)
- `try/catch` wraps the handler call ONLY. Finalization and callback fan-out run outside it, so a consumer-callback error can never be misattributed to the job
- `_handleJobSuccess` / `_handleJobFailure` UPDATE `WHERE id = $1 AND status = 'running' AND attempts = $n` and return `Job | null`. `null` = somebody else finalized the row meanwhile (reaper → `expired`): the attempt log row is still written, a warning is logged, no events are published, the terminal state stays
- Consequence: `expired` is truly terminal; a late handler never resurrects a job and `onDone` fires at most once per terminal transition

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
- "Stuck" = `updated_at < NOW() - threshold` (current attempt's claim time). NEVER `started_at`: that is the first attempt's start and would reap legitimate retries whose cumulative backoff exceeds the threshold
- Pass `autoCleanup: true` (or a config) to run the reaper automatically on a timer (default: every 60s, threshold 5min). `stop()` awaits an in-flight tick; a tick that outlives its `stop()` sees a bumped `#lifecycleGen` and does not reschedule
- Expired status is terminal (no auto-retry, never overwritten by a late handler) — work may be stale by the time we notice

### Retention (`purge`)
- Nothing deletes finished jobs automatically. `jobs.purge(olderThanMinutes?, { statuses?, tenant_id? })` DELETEs terminal rows by `COALESCE(completed_at, updated_at)`; attempt log cascades via FK
- Only `completed` / `failed` / `expired` are purgeable; anything else throws `TypeError`. All values bound, never interpolated

### Graceful Shutdown
- `start()` is idempotent (second call is a no-op with a warning) and THROWS on init failure
- `start(n > 1)` THROWS when `db` is a `pg.Client`: concurrent `withTransaction` calls on one connection interleave BEGIN/COMMIT/ROLLBACK (verified: one caller's ROLLBACK discards the other's uncommitted writes). Pool for concurrency
- SIGTERM handler is added on `start()` and removed on `stop()` (no listener leak across instances)
- After the SIGTERM-triggered `stop()` resolves, the handler re-raises `SIGTERM` via `process.kill(process.pid, "SIGTERM")` IF `process.listenerCount("SIGTERM") === 0`. Reason: any installed listener suppresses the runtime's default terminate-on-SIGTERM, so without this the process idles until SIGKILL. Consumers with their own listener own the exit
- `stop()` awaits currently-running jobs (and an in-flight auto-cleanup tick) before returning
- `resetHard()` always runs `_initialize(hard)`, even on an initialized instance

### Events
- ALL events are in-process: published by the instance that finalizes the job (its processors / its `cleanup()`), never via the DB. A process that only creates jobs sees nothing; per-uid registrations there leak until `unsubscribeAll()` — documented, not solved
- Type-keyed subscribers are wrapped in `#onEvent` (try/await/catch); per-uid callbacks (`onDoneFor`, `onAttemptFor`, `create(..., onDone)`) go through `_events.ts` `_safeInvoke` (sync throw caught, returned promise gets a rejection handler). A consumer error is logged and dropped — it never touches the job
- `#onEventWraps` is per-instance and keyed by `(type, cb)` — safe for callbacks shared across Jobs instances and for multi-type subscribe+unsubscribe
- `unsubscribeAll()` clears the pubsubs, the internal wrap registry AND both per-uid maps

### Tenancy (`tenant_id`)
- **Optional, audit-only, no FK.** `tenant_id` is a nullable `VARCHAR(255)` tag on `__job` only (NOT on the attempt-log table — reachable via `job_id`). It follows the ecosystem `tenant_id` convention but deliberately omits the `tenantIdFk`/registry coupling: a job queue is infrastructure, and `ON DELETE CASCADE` would destroy the very audit trail the column exists for.
- **NULL = global/un-scoped**, chosen over a `NOT NULL DEFAULT 'default'` sentinel so infra jobs are represented honestly and the self-heal `ALTER` stays metadata-only.
- **Write path:** `create(type, payload, { tenant_id })`. In `_create.ts` the allowlist transformer returns `undefined` for empty/null, so `dataToSqlParams` OMITS the column and a no-tenant INSERT is byte-identical to pre-tenant steve (DB applies NULL). `Jobs.create` forwards `tenant_id` into the DTO unconditionally (undefined when absent — same convention as `run_at`).
- **Read/maintenance filters** are all OPTIONAL and default to today's behavior: `fetchAll(status, { tenant_id })` (interpolated via `pgQuoteValue`, same trust model as the status filter), `find(uid, withAttempts, { tenant_id })` (guard; mismatch → not-found), `healthPreview(mins, { tenant_id })` and `cleanup(mins, { tenant_id })` (both **bind** the tenant values via `= ANY($n::varchar[])`, never interpolate).
- **Claiming is tenant-blind by design.** `_claim-next.ts` is UNCHANGED (zero bound params); a worker pool drains all tenants incl. global NULL jobs. Per-tenant worker pools, cross-tenant fairness, and `claimTenantIds` were intentionally left out of scope.
- **`autoCleanup` is always tenant-blind** (the scheduled reaper calls `cleanup()` with no tenant). Scoped reaping is manual-only.
- **Events are tenant-blind**: type-keyed `onDone`/`onAttempt` fire across ALL tenants — filter on `job.tenant_id` in the callback. `onDoneFor`/`create(onDone)` are uid-keyed and inherently tenant-safe.
- `JobContext` did NOT change (no per-instance tenant state); `static __schema(prefix)` did NOT change (always emits the column + partial index unconditionally — zero cost when unused).

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
- `tests/tenant.test.ts` — optional `tenant_id` (tag/default-null, fetchAll/find/healthPreview/cleanup filters, tenant-blind claiming, and the `tenant_id` self-heal on a pre-tenant table)
- `tests/fixes-v3.test.ts` — regression guards for the post-3.0 review fixes (reaper on `updated_at`, fenced finalization, per-uid callback isolation, prototype-safe dispatch, `pg.Client` single processor, init dedupe / no boot-time exclusive lock, `purge`, `find` not-found, `unsubscribeAll`, SIGTERM re-raise via subprocess `tests/_sigterm-child.ts`)

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
| Tests | `tests/jobs.test.ts`, `tests/db-resilience.test.ts`, `tests/fixes.test.ts`, `tests/tenant.test.ts`, `tests/fixes-v3.test.ts` |
| Example server | `example/server.ts` |
| Config | `deno.json` |
