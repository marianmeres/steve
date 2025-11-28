# Database Retry and Health Monitoring

## Overview

Steve now includes built-in database retry logic and health monitoring to improve resilience and observability.

## Features

### 1. Automatic Database Retry

Automatically retry database operations on transient failures like connection timeouts, connection resets, etc.

### 2. Health Monitoring

Periodically check database health and get notified when the database becomes unhealthy or recovers.

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
		retryableErrors: [          // Custom error codes to retry
			'ECONNREFUSED',
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

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `maxRetries` | number | 3 | Maximum number of retry attempts |
| `initialDelayMs` | number | 100 | Initial delay before first retry (ms) |
| `maxDelayMs` | number | 5000 | Maximum delay between retries (ms) |
| `backoffMultiplier` | number | 2 | Multiplier for exponential backoff |
| `retryableErrors` | string[] | See below | Error codes that trigger retry |

**Default Retryable Errors:**
- `ECONNREFUSED` - Connection refused
- `ECONNRESET` - Connection reset
- `ETIMEDOUT` - Operation timed out
- `ENOTFOUND` - DNS lookup failed
- `57P03` - PostgreSQL: cannot_connect_now
- `08006` - PostgreSQL: connection_failure
- `08003` - PostgreSQL: connection_does_not_exist
- `08000` - PostgreSQL: connection_exception

### DbHealthCheckOptions

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `intervalMs` | number | 30000 | How often to check health (ms) |
| `onUnhealthy` | function | undefined | Callback when DB becomes unhealthy |
| `onHealthy` | function | undefined | Callback when DB recovers |

### DbHealthStatus

```typescript
interface DbHealthStatus {
	healthy: boolean;      // Whether the database is healthy
	latencyMs: number;     // Query latency in milliseconds
	error: string | null;  // Error message if unhealthy
	timestamp: Date;       // When the check was performed
	pgVersion?: string;    // PostgreSQL version number
}
```

## API Methods

### `jobs.getDbHealth(): DbHealthStatus | null`

Returns the last health check result, or `null` if health monitoring is not enabled.

### `jobs.checkDbHealth(): Promise<DbHealthStatus>`

Manually performs a health check and returns the result. Works even if health monitoring is not enabled.

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
