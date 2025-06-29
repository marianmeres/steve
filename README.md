# @marianmeres/steve

PostgreSQL based jobs processing manager. 

Supports atomic concurrency, multiple "workers" (job processors), configurable 
retry logic, backoff, detailed logging and more...

Uses [node-postgres](https://node-postgres.com/) internally.

## Installation

```shell
deno add jsr:@marianmeres/steve
```

```shell
npm i @marianmeres/steve
```

## Basic Usage

```typescript
import { createJobs } from "@marianmeres/steve";

// the manager instance
const jobs = await createJobs({
    db, // pg.Pool or pg.Client 
    jobHandler(job: Job) {
        // - do the work... 
        // - may dispatch the work to another handlers based on the `job.type`
        // - must throw on error
        // - returned data will be available as the `result` prop 
    },
});

// kicks off the job processing (with, let's say, 2 concurrent processors)
jobs.start(2);

// now the system is ready to handle any incoming jobs...

// stops processing (while gracefully finishes all currently running jobs)
jobs.stop();
```

## Creating a job

```typescript
const job = await jobs.create(
    'my_job_type', // required
    { foo: 'bar' }, // optional payload
    // optional options
    {
        // maximum number of attempts before giving up and marking the job as failed
        max_attempts: 3, // default: 3
        // default: 'exp' (exponential backoff with 2^attempts seconds)
        backoff_strategy: 'none' // or 'exp', 
    } 
);
```

## Listening to success and/or failure

```typescript
jobs.onFailure('my_important_job_type', (failed: Job) => {
    // this is triggered once once max_attempts are reached (not on retries)
});

jobs.onSuccess('my_job_type', (job: Job) => {
    console.log(job.result);
});
```

## Examining the job manually

```typescript
jobs.find(
    uid: string,
    withAttempts: boolean = false
): Promise<{ job: Job; attempts: null | JobAttempt[] }>;
```

## Listing all

```typescript
jobs.fetchAll(
    status: undefined | null | Job["status"] | Job["status"][] = null,
    options: Partial<{ limit: number; offset: number; }> = {}
): Promise<Job[]>
```

## The Interfaces

```typescript
interface Job {
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

// the "debug" log of each attempt
interface JobAttempt {
    id: number;
    job_id: string;
    attempt_number: number;
    started_at: Date;
    completed_at: Date;
    status: typeof ATTEMPT_STATUS.SUCCESS | typeof ATTEMPT_STATUS.ERROR;
    error_message: null;
    error_details: null | Record<"stack" | string, any>;
}
```