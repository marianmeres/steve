# Agent Context: @marianmeres/steve

## Package Overview

- **Name**: `@marianmeres/steve`
- **Type**: PostgreSQL job queue/processing library
- **Runtime**: Deno and Node.js
- **Version**: 1.9.3
- **License**: MIT

## Purpose

Steve is a PostgreSQL-based job processing manager that provides:
- Distributed job queue with multiple concurrent workers
- Automatic retry with configurable exponential backoff
- Job scheduling (delayed execution)
- Database resilience with connection retry logic
- Health monitoring with state change callbacks
- Audit trail via attempt logging

## Architecture

```
src/
├── mod.ts                  # Main entry point, re-exports public API
└── steve/
    ├── jobs.ts             # Main Jobs class and public types
    ├── job/                # Internal job operations
    │   ├── _schema.ts      # Database schema creation/teardown
    │   ├── _create.ts      # Job creation
    │   ├── _claim-next.ts  # Atomic job claiming
    │   ├── _execute.ts     # Job execution orchestration
    │   ├── _handle-success.ts
    │   ├── _handle-failure.ts
    │   ├── _find.ts        # Job querying
    │   ├── _log-attempt.ts # Attempt logging
    │   ├── _mark-expired.ts
    │   └── _health-preview.ts
    └── utils/
        ├── with-db-retry.ts   # Retry with exponential backoff
        ├── db-health.ts       # Health checking/monitoring
        ├── sleep.ts           # Promise-based delay
        ├── pg-quote.ts        # SQL escaping
        └── with-timeout.ts    # Timeout wrapper
```

## Public API Exports

From `src/mod.ts`:

### Classes
- `Jobs` - Main job manager class

### Functions
- `withDbRetry<T>(fn, options?)` - Wraps async function with retry logic
- `checkDbHealth(db, logger?)` - One-time database health check

### Interfaces
- `Job` - Job row representation
- `JobAttempt` - Attempt log entry
- `JobCreateOptions` - Options for creating jobs
- `JobsOptions` - Jobs constructor options
- `JobContext` - Internal context (exported but internal use)
- `DbRetryOptions` - Retry configuration
- `DbHealthStatus` - Health check result

### Types
- `JobHandler` - `(job: Job) => any | Promise<any>`
- `JobHandlersMap` - `Record<string, JobHandler | null | undefined>`
- `JobAwareFn` - Callback for job events

### Constants
- `JOB_STATUS` - `{ PENDING, RUNNING, COMPLETED, FAILED, EXPIRED }`
- `ATTEMPT_STATUS` - `{ SUCCESS, ERROR }`
- `BACKOFF_STRATEGY` - `{ NONE, EXP }`

## Database Schema

Two tables are created (with configurable prefix):

### `__job`
| Column | Type | Description |
|--------|------|-------------|
| id | SERIAL | Primary key |
| uid | UUID | Unique identifier |
| type | VARCHAR | Job type for routing |
| payload | JSONB | Custom job data |
| result | JSONB | Handler return value |
| status | VARCHAR | pending/running/completed/failed/expired |
| attempts | INT | Attempt count |
| max_attempts | INT | Max retry attempts |
| max_attempt_duration_ms | INT | Timeout per attempt |
| backoff_strategy | VARCHAR | none/exp |
| created_at | TIMESTAMP | Creation time |
| updated_at | TIMESTAMP | Last update |
| started_at | TIMESTAMP | First execution start |
| completed_at | TIMESTAMP | Final completion |
| run_at | TIMESTAMP | Scheduled execution time |

### `__job_attempt_log`
| Column | Type | Description |
|--------|------|-------------|
| id | SERIAL | Primary key |
| job_id | INT | Foreign key to __job |
| attempt_number | INT | Sequential attempt number |
| started_at | TIMESTAMP | Attempt start |
| completed_at | TIMESTAMP | Attempt end |
| status | VARCHAR | success/error |
| error_message | TEXT | Error message if failed |
| error_details | JSONB | Full error with stack trace |

## Key Behaviors

### Job Claiming
- Uses `FOR UPDATE SKIP LOCKED` for atomic claiming
- Prevents race conditions between workers
- Only claims jobs where `run_at <= NOW()` and `status = 'pending'`

### Retry Logic
- Default: 3 attempts with exponential backoff
- Backoff formula: `2^attempts` seconds
- Configurable via `max_attempts` and `backoff_strategy`

### Job Status Flow
```
PENDING → RUNNING → COMPLETED
                  ↘ PENDING (retry)
                  ↘ FAILED (max attempts reached)
                  ↘ EXPIRED (running too long)
```

### Graceful Shutdown
- SIGTERM handler by default (configurable)
- Waits for active jobs to complete before stopping

## Dependencies

- `pg` - PostgreSQL driver
- `@marianmeres/clog` - Logger
- `@marianmeres/pubsub` - Event system
- `@marianmeres/data-to-sql-params` - SQL parameter builder

## Testing

```bash
deno test -A --env-file
```

Requires PostgreSQL with credentials in `.env` file:
```
TEST_PG_HOST=localhost
TEST_PG_DATABASE=test
TEST_PG_USER=test
TEST_PG_PASSWORD=test
TEST_PG_PORT=5432
```

## Common Patterns

### Basic Usage
```typescript
const jobs = new Jobs({
  db: pgPool,
  jobHandler: async (job) => { /* process */ },
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
  if (job.status === "completed") { /* success */ }
});

jobs.onAttempt("email", (job) => {
  console.log(`Attempt ${job.attempts}`);
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
| Health utility | `src/steve/utils/db-health.ts` |
| Tests | `tests/jobs.test.ts`, `tests/db-resilience.test.ts` |
| Example server | `example/server.ts` |
| Config | `deno.json` |
