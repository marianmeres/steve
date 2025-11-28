import type pg from "pg";
import type { Logger } from "@marianmeres/clog";

export interface DbHealthStatus {
	healthy: boolean;
	latencyMs: number | null;
	error: string | null;
	timestamp: Date;
	pgVersion?: string;
}

/**
 * Performs a simple health check against the database
 */
export async function checkDbHealth(
	db: pg.Pool | pg.Client,
	logger?: Logger
): Promise<DbHealthStatus> {
	const start = Date.now();
	const timestamp = new Date();

	try {
		// Simple query to test connection
		const result = await db.query("SELECT version(), NOW() as now");
		const latencyMs = Date.now() - start;

		return {
			healthy: true,
			latencyMs,
			error: null,
			timestamp,
			pgVersion: result.rows[0]?.version?.split(" ")[1], // Extract version number
		};
	} catch (error: any) {
		const latencyMs = Date.now() - start;
		logger?.error?.(`DB health check failed: ${error?.message}`);

		return {
			healthy: false,
			latencyMs,
			error: error?.message || String(error),
			timestamp,
		};
	}
}

/**
 * Periodic health check monitor
 */
export class DbHealthMonitor {
	#db: pg.Pool | pg.Client;
	#logger?: Logger;
	#intervalMs: number;
	#timeoutId: any = null;
	#isRunning = false;
	#lastStatus: DbHealthStatus | null = null;
	#onUnhealthy?: (status: DbHealthStatus) => void;
	#onHealthy?: (status: DbHealthStatus) => void;

	constructor(
		db: pg.Pool | pg.Client,
		options: {
			intervalMs?: number;
			logger?: Logger;
			onUnhealthy?: (status: DbHealthStatus) => void;
			onHealthy?: (status: DbHealthStatus) => void;
		} = {}
	) {
		this.#db = db;
		this.#logger = options.logger;
		this.#intervalMs = options.intervalMs || 30_000; // default 30s
		this.#onUnhealthy = options.onUnhealthy;
		this.#onHealthy = options.onHealthy;
	}

	async start(): Promise<void> {
		if (this.#isRunning) return;

		this.#isRunning = true;
		await this.#scheduleNext();
	}

	stop(): void {
		this.#isRunning = false;
		if (this.#timeoutId) {
			clearTimeout(this.#timeoutId);
			this.#timeoutId = null;
		}
	}

	getLastStatus(): DbHealthStatus | null {
		return this.#lastStatus;
	}

	async #scheduleNext(): Promise<void> {
		if (!this.#isRunning) return;

		// Perform the check
		await this.#check();

		// Schedule next check (only if still running)
		if (this.#isRunning) {
			this.#timeoutId = setTimeout(() => this.#scheduleNext(), this.#intervalMs);
		}
	}

	async #check(): Promise<void> {
		const status = await checkDbHealth(this.#db, this.#logger);
		const wasHealthy = this.#lastStatus?.healthy ?? true;

		this.#lastStatus = status;

		// Trigger callbacks on state changes
		if (!status.healthy && wasHealthy) {
			this.#logger?.error?.("Database became unhealthy");
			this.#onUnhealthy?.(status);
		} else if (status.healthy && !wasHealthy) {
			this.#logger?.debug?.("Database recovered");
			this.#onHealthy?.(status);
		}

		// Log if unhealthy
		if (!status.healthy) {
			this.#logger?.warn?.(
				`DB health check failed (latency: ${status.latencyMs}ms): ${status.error}`
			);
		}
	}
}
