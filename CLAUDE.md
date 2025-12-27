# CLAUDE.md

## Quick Context

**Steve** is a PostgreSQL-based job queue library for Deno/Node.js.

## What It Does

- Manages background jobs with concurrent workers
- Provides automatic retry with exponential backoff
- Supports job scheduling (delayed execution)
- Includes database resilience and health monitoring

## Key Files

- `src/mod.ts` - Entry point, exports public API
- `src/steve/jobs.ts` - Main `Jobs` class (600+ lines)
- `src/steve/utils/with-db-retry.ts` - Retry utility
- `src/steve/utils/db-health.ts` - Health monitoring

## Usage Pattern

```typescript
import { Jobs } from "@marianmeres/steve";

const jobs = new Jobs({
  db: pgPool,
  jobHandler: async (job) => { return result; },
});

await jobs.start(2);  // 2 workers
await jobs.create("type", { payload: data });
await jobs.stop();
```

## Testing

```bash
deno test -A --env-file
```

Needs PostgreSQL with `TEST_PG_*` env vars.

## Key Concepts

- **Job statuses**: pending, running, completed, failed, expired
- **Backoff strategies**: none, exp (2^attempts seconds)
- **Atomic claiming**: Uses `FOR UPDATE SKIP LOCKED`
- **Event system**: `onDone()`, `onAttempt()` callbacks

## Database Tables

- `__job` - Main jobs table
- `__job_attempt_log` - Attempt history/audit

## Dependencies

`pg`, `@marianmeres/clog`, `@marianmeres/pubsub`
