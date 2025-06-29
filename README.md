# @marianmeres/steve

Atomic, PostgreSQL based ([node-postgres](https://node-postgres.com/)), simple yet 
extensible jobs manager. Supporting multiple concurrent job queue processors, configurable 
retry logic, backoff, detailed logging and more...

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

// first, create jobs processing manager instance
const jobs = await createJobs({
    // pass in the pg.Pool or pg.Client 
    db,
    // actual core job handler worker
    (job: Job) => {
        // - do the work... may dispatch to another handlers based on the `job.type` 
        //   (arbitrary string value)
        // - must throw on error (to be able to recognize as failed state)
        // - if desired, can return data which will be available as the `result` prop 
        //   (and will be serialized in the db as well)
    },
    // optional custom delay in ms before idle worker will try to claim another pending job. 
    // This does a DB read, so you probably don't want a crazy small number (default 1_000)
    pollTimeoutMs: number
});

// kick off the job processing (let's say, with 2 concurrent processors)
jobs.start(2);

// now the system is ready to handle any incoming jobs...

// To stop the processing, just call `stop` which will gracefully finish all running jobs
// and will not start any other
jobs.stop();
```

## Creating a job

```typescript
await jobs.create(
    // required arbitrary string value
    'my_job_type',
    // optional arbitrary job data... will be available as the `payload` prop in the handler
    // must be JSON serializable
    { foo: 'bar' },
    // optional job processor customization
    {
        // maximum number of attempts before the system will give up and mark the job as failed
        // (default 3)
        max_attempts: number;
        // backoff strategy to use on error (default is exponential backoff with 2^attempts seconds)
        backoff_strategy: 'none' | 'exp';
    }
);
```

## Listening to jobs successes or failures

```typescript
//
jobs.onFailure('my_important_job_type', (failed: Job) => {
    // do something on job failure. Note that this is not triggered on error (which will
    // be retried), but only on "true" failure.
});

//
jobs.onSuccess('my_job_type', (job: Job) => {
    // do someting on job success
    console.log(job.result);
});
```

