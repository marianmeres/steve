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
import { Jobs } from "@marianmeres/steve";

// the manager instance
const jobs = new Jobs({
    db, // pg.Pool or pg.Client 
    jobHandler(job: Job) {
        // Do the work... 
        // May dispatch the work to another handlers based on the `job.type`.
        // Must throw on error.
        // Returned data will be available as the `result` prop.
    },
    // how long should the worker be idle before trying to claim a new job
    pollIntervalMs, // default 1_000
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
    {
        max_attempts: 3, // maximum number of retry attempts before giving up
        backoff_strategy: 'none' // or 'exp' (exp. backoff with 2^attempts seconds), 
    } // optional
);
```

## Listening to success and/or failure

```typescript
jobs.onFailure('my_important_job_type', (failed: Job) => {
    // this is triggered once max_attempts are reached (not on retry-able error)
});

jobs.onSuccess('my_job_type', (job: Job) => {
    console.log(job.result);
});

// also, every attempt can be listened to as well
jobs.onAttempt('my_job_type', (job: Job) => {
    console.log('maybe success, maybe failure, maybe planned retry', job.status);
})
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

## Jobs monitor example

![](./demo-monitor.png "Demo monitor")

Steve comes with toy example of jobs monitoring ([server](example/server.ts) 
and [client](example/index.html)). To run it locally follow these steps:

```shell
git clone git@github.com:marianmeres/steve.git
cd steve
cp .env.example .env
```

Now edit the `.env` and set `EXAMPLE_PG_*` postgres credentials. Then, finally, 
run the server:

```shell
deno task example
```

Once deps are installed and server is running, just visit http://localhost:8000.
