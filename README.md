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

## Usage

```typescript
const jobs = await createJobs({
    db,
    jobHandler,
    logger: (...args: any) => _logger.push(args[0]),
    // must be turned off in tests... (it leaves active process listener, which deno complains about)
    gracefulSigterm: false,
    pollTimeoutMs,
    tablePrefix,
});
```
