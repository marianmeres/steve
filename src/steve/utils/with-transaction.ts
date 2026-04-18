/**
 * @module with-transaction
 *
 * Provides a transactional wrapper that runs BEGIN/COMMIT/ROLLBACK on a single
 * dedicated connection.
 *
 * When a `pg.Pool` is used, calling `pool.query("BEGIN"); pool.query(...); pool.query("COMMIT")`
 * is NOT a transaction — each call may check out a different client from the pool.
 * This helper acquires a client once and routes all work through it.
 */

import type pg from "pg";

/** Lowest-common-denominator queryable — everything we need in transactional helpers. */
// deno-lint-ignore no-explicit-any -- pg's .query overloads are complex and vary by driver
export type Queryable = { query: (...args: any[]) => Promise<any> };

/**
 * Runtime duck-type check for a `pg.Pool` vs `pg.Client`.
 *
 * `pg.Pool` exposes `totalCount`, `idleCount`, `waitingCount`; `pg.Client` does not.
 */
export function isPool(db: pg.Pool | pg.Client): db is pg.Pool {
	return (
		typeof (db as unknown as { connect?: unknown }).connect === "function" &&
		"totalCount" in db
	);
}

/**
 * Runs `fn` inside a transaction on a dedicated client.
 *
 * - If `db` is a `pg.Pool`, acquires a client via `.connect()` and releases it in `finally`.
 * - If `db` is a `pg.Client`, uses it directly (caller owns the connection lifecycle).
 *
 * Issues `BEGIN`, calls `fn(client)`, then `COMMIT` on success or `ROLLBACK` on error.
 */
export async function withTransaction<T>(
	db: pg.Pool | pg.Client,
	fn: (client: pg.PoolClient | pg.Client) => Promise<T>
): Promise<T> {
	const pool = isPool(db);
	const client = pool
		? await (db as pg.Pool).connect()
		: (db as pg.Client);
	try {
		await client.query("BEGIN");
		try {
			const result = await fn(client);
			await client.query("COMMIT");
			return result;
		} catch (e) {
			try {
				await client.query("ROLLBACK");
			} catch {
				// ROLLBACK itself may fail on an already-aborted connection; best-effort.
			}
			throw e;
		}
	} finally {
		if (pool) (client as pg.PoolClient).release();
	}
}
