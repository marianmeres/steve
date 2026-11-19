# Database Retry and Health Monitoring

## Overview

Steve includes built-in database retry logic and health monitoring to improve resilience and observability. Both run on [sqlkit](https://www.npmjs.com/package/@marianmeres/sqlkit)'s retry and health check.

## Features

### 1. Automatic Database Retry

Automatically retry database operations on transient failures: a lost or refused connection, a server starting up, shutting down or out of connections, a deadlock, a serialization failure, a lock not granted in time.

### 2. Health Monitoring

Periodically check database health and get notified when the database becomes unhealthy or recovers. A check that has not answered within 5 s is unhealthy.

## Usage Examples

### Basic Usage with Defaults

```typescript
import { Jobs } from "@marianmeres/steve";

const jobs = new Jobs({
	db,
	jobHandler: myHandler,

	// Enable retry with default settings
	dbRetry: true,

	// Enable health monitoring with default settings (checks every 30s)
	dbHealthCheck: true,
});

await jobs.start(2);
```

### Custom Retry Configuration

```typescript
const jobs = new Jobs({
	db,
	jobHandler: myHandler,

	// Custom retry settings
	dbRetry: {
		maxRetries: 5,              // Retry up to 5 times
		initialDelayMs: 200,        // Start with 200ms delay
		maxDelayMs: 10_000,         // Cap delay at 10 seconds
		backoffMultiplier: 2,       // Double the delay each retry
		retryableErrors: [          // Optional: replaces the default classification
			'ECONNREFUSED',         // with exactly these codes
			'ECONNRESET',
			'ETIMEDOUT',
		],
	},
});
```

### Custom Health Monitoring with Callbacks

```typescript
const jobs = new Jobs({
	db,
	jobHandler: myHandler,

	// Custom health check settings
	dbHealthCheck: {
		intervalMs: 60_000, // Check every minute
		timeoutMs: 2_000,   // A check not answered within 2s is unhealthy (default 5s)

		onUnhealthy: (status) => {
			// Alert your monitoring system
			console.error('Database became unhealthy!', {
				error: status.error,
				latency: status.latencyMs,
				timestamp: status.timestamp,
			});

			// Send to monitoring service
			monitoring.alert('DB_UNHEALTHY', status);
		},

		onHealthy: (status) => {
			// Log recovery
			console.log('Database recovered!', {
				latency: status.latencyMs,
				pgVersion: status.pgVersion,
			});

			monitoring.resolve('DB_UNHEALTHY');
		},
	},
});

await jobs.start(2);

// Check health anytime
const health = jobs.getDbHealth();
if (health) {
	console.log('DB healthy:', health.healthy);
	console.log('Latency:', health.latencyMs, 'ms');
	console.log('PostgreSQL version:', health.pgVersion);
}

// Or manually trigger a health check
const currentHealth = await jobs.checkDbHealth();
console.log('Current health:', currentHealth);
```

### Integration with Express/Web Server

```typescript
import express from 'express';
import { Jobs } from "@marianmeres/steve";

const app = express();

const jobs = new Jobs({
	db,
	jobHandler: myHandler,
	dbRetry: true,
	dbHealthCheck: {
		intervalMs: 30_000,
		onUnhealthy: (status) => {
			// Maybe pause accepting new jobs
			console.error('DB unhealthy, degraded mode');
		},
	},
});

await jobs.start(2);

// Health check endpoint
app.get('/health', (req, res) => {
	const dbHealth = jobs.getDbHealth();

	if (!dbHealth || !dbHealth.healthy) {
		return res.status(503).json({
			status: 'unhealthy',
			database: dbHealth,
		});
	}

	res.json({
		status: 'healthy',
		database: {
			healthy: true,
			latency: dbHealth.latencyMs,
			version: dbHealth.pgVersion,
		},
	});
});
```

## Configuration Reference

### DbRetryOptions

| Option              | Type     | Default   | Description                           |
| ------------------- | -------- | --------- | ------------------------------------- |
| `maxRetries`        | number   | 3         | Maximum number of retry attempts      |
| `initialDelayMs`    | number   | 100       | Initial delay before first retry (ms) |
| `maxDelayMs`        | number   | 5000      | Maximum delay between retries (ms)    |
| `backoffMultiplier` | number   | 2         | Multiplier for exponential backoff    |
| `retryableErrors`   | string[] | See below | Error codes that trigger retry        |

`maxRetries` is a non-negative integer and `backoffMultiplier` at least 1; an option of the wrong type or out of range is a `TypeError` at the first database call. The wait before retry `n` is `initialDelayMs * backoffMultiplier ** (n - 1)`, at most `maxDelayMs`.

**What is retried by default.** Without `retryableErrors`, an error is retried when sqlkit's Postgres classifier calls it retryable, whether it is a sqlkit `SqlError` or a raw node-postgres error:

| Kind          | What happened                                     | Codes                                                                                                                                                         |
| ------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| connection    | the connection could not be made, or was lost     | `ECONNREFUSED`, `ECONNRESET`, `ETIMEDOUT`, `ENOTFOUND`, `EPIPE`, `EAI_AGAIN`, class `08`; node-postgres's connect timeout and terminated connection (no code) |
| connection    | the server is shutting down, starting up, or full | `57P01`, `57P02`, `57P03`, `53300`                                                                                                                            |
| deadlock      | chosen as a deadlock's victim                     | `40P01`                                                                                                                                                       |
| serialization | a concurrent transaction won                      | `40001`                                                                                                                                                       |
| busy          | a lock was not granted in time                    | `55P03`                                                                                                                                                       |

A code that appears only inside an error's message does not count.

**`retryableErrors`** replaces that classification with exactly its list: an error is retried when its `code` is one of them, or its message contains one.

A retry runs the whole operation again: steve wraps one statement, or one whole transaction, at a time. Inside a transaction of your own (a sqlkit `Driver` you share with steve) a retry cannot help: after a failure Postgres has aborted that transaction.

### DbHealthCheckOptions

| Option        | Type     | Default   | Description                        |
| ------------- | -------- | --------- | ---------------------------------- |
| `intervalMs`  | number   | 30000     | How often to check health (ms)     |
| `timeoutMs`   | number   | 5000      | A check not answered by then fails |
| `onUnhealthy` | function | undefined | Callback when DB becomes unhealthy |
| `onHealthy`   | function | undefined | Callback when DB recovers          |

### DbHealthStatus

```typescript
interface DbHealthStatus {
	healthy: boolean;          // Whether the database is healthy
	latencyMs: number | null;  // Query latency in ms (may be a fraction); null on failure
	error: string | null;      // The driver's message, or the timeout's; null when healthy
	timestamp: Date;           // When the check was sent
	pgVersion?: string;        // PostgreSQL version ("18.6"), once known, when healthy
}
```

The next check starts `intervalMs` after the previous one answered or timed out, so checks never overlap, and the monitor's timers never keep a process alive. `onUnhealthy` fires when the database goes from healthy to unhealthy (or the first check fails), `onHealthy` when it recovers. Steve logs on those changes only, not on every failed check.

## Errors

A failed database call rejects with a `SqlError` from `@marianmeres/sqlkit` (`ConnectionError`, `DeadlockError`, …). `code` and `message` are the driver's (node-postgres's for a pool or a client); the original error is `cause`, where fields such as `detail` or `severity` are read. `retryable` is `true` for the kinds retried by default. See [API.md](API.md#errors).

## API Methods

### `jobs.getDbHealth(): DbHealthStatus | null`

Returns the last health check result, or `null` if health monitoring is not enabled.

### `jobs.checkDbHealth(): Promise<DbHealthStatus>`

Manually performs a health check and returns the result, with the default 5 s timeout. Works even if health monitoring is not enabled, and never rejects for a database that is down.

## Benefits

1. **Resilience**: Automatically recover from transient database failures
2. **Observability**: Monitor database health in real-time
3. **Zero Downtime**: Detect and handle database issues before they impact users
4. **Integration**: Easy integration with monitoring systems (Prometheus, Datadog, etc.)
5. **Debugging**: Detailed error logging helps identify connection issues

## Best Practices

1. **Enable both features**: Use retry + health monitoring together for best results
2. **Monitor callbacks**: Use `onUnhealthy` to alert your team or monitoring system
3. **Set appropriate intervals**: Balance between responsiveness and database load
4. **Test failure scenarios**: Simulate database failures to ensure proper handling
5. **Log retry attempts**: Review logs to identify persistent connection issues
