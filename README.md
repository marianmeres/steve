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

### Job handlers

Job handling function(s) can be specified via constructor options either as a single
`jobHandler` function or as a `jobHandlers` functions map by type. Both options 
`jobHandlers` and `jobHandler` can be used together, where the `jobHandlers` map will 
have priority and `jobHandler` will act as a fallback.

If none of the `jobHandlers` or `jobHandler` options is specified, the system will still be
normally functional all incoming jobs will be handled with the internal `noop` handler.

### Example

```typescript
import { Jobs } from "@marianmeres/steve";

// the manager instance
const jobs = new Jobs({
    // pg.Pool or pg.Client 
    db, 
    // global job handler for all jobs
    jobHandler: (job: Job) => {
        // Do the work... 
        // Must throw on error.
        // Returned data will be available as the `result` prop.
    },
    // or, jobHandlers by type map
    jobHandlers: {
        my_job_type: (job: Job) => { /*...*/ },
        // ...
    },
    // how long should the worker be idle before trying to claim a new job
    pollIntervalMs, // default 1_000
});

// later, as new job types are needed, just re/set handler
jobs.setHandler('my_type', myHandler);
jobs.setHandler('my_type', null); // this removes the `my_type` handler altogether

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
    }, // optional options
    // optional "onDone" callback for this particular job
    function onDone(job: Job) {
        // job is either completed or failed... see `job.status`
    }
);
```

## Listening to job events

All `onXYZ` methods below return `unsubscribe` function.

```typescript
jobs.onDone('my_job_type', (job: Job) => {
    // job is either completed or failed... see `job.status`
    // note that status `failed` is only set once 
    // max_attempts retries were reached
});

jobs.onAttempt('my_job_type', (job: Job) => {
    // maybe completed, maybe failed, maybe pending (planned retry)... see `job.status`
});
```

## Examining the job manually

```typescript
jobs.find(
    uid: string,
    withAttempts: boolean = false
): Promise<{ job: Job; attempts: null | JobAttempt[] }>;
```

## Listing all jobs

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
