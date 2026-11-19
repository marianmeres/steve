/**
 * @module driver
 *
 * The one seam between steve and the database: `toDriver(db)` turns what a host passes
 * as `JobsOptions.db` into a sqlkit `Driver`, and everything else in steve talks to
 * that `Driver`.
 *
 * A `transaction()` on it pins one connection for its length, checks that the `COMMIT`
 * committed, and destroys a connection whose `ROLLBACK` failed. On a single connection
 * it gives each transaction its turn. Every database failure comes out as a sqlkit
 * `SqlError` with the driver's own error as `cause`.
 */

import type { Driver } from "@marianmeres/sqlkit";
import {
	createPgClientDriver,
	createPgDriver,
	type PgPoolLike,
	type PgStandaloneClientLike,
} from "@marianmeres/sqlkit/pg";

/**
 * What `JobsOptions.db` takes: a node-postgres `pg.Pool`, a `pg.Client`, or a sqlkit
 * `Driver`. The first two are declared by shape, so nothing here imports `pg`.
 */
export type SteveDb = PgPoolLike | PgStandaloneClientLike | Driver;

/**
 * One driver per pool or client object, however many callers share it: building a
 * driver adds an `error` listener to the pool or client, and `checkDbHealth(pool)` may
 * be called on a timer.
 */
const drivers = new WeakMap<object, Driver>();

/** Whether `db` is a sqlkit `Driver` (by shape). */
export function isDriver(db: unknown): db is Driver {
	const d = db as Partial<Driver> | null;
	return (
		typeof d === "object" &&
		d !== null &&
		typeof d.dialect === "string" &&
		typeof d.query === "function" &&
		typeof d.exec === "function" &&
		typeof d.transaction === "function" &&
		typeof d.capabilities === "object" &&
		d.capabilities !== null
	);
}

/**
 * Runtime duck-type check for a `pg.Pool` vs a `pg.Client`.
 *
 * `pg.Pool` exposes `totalCount`, `idleCount`, `waitingCount`; `pg.Client` does not.
 */
export function isPool(db: unknown): db is PgPoolLike {
	return (
		typeof db === "object" &&
		db !== null &&
		typeof (db as { connect?: unknown }).connect === "function" &&
		"totalCount" in db
	);
}

/**
 * The `Driver` steve runs on, for what a host passed as `db`.
 *
 * - A sqlkit `Driver` is used as it is: not cached, not wrapped, never closed. One
 *   whose dialect is not `pg` is refused with a `TypeError`: steve runs on PostgreSQL.
 * - A `pg.Pool` or a `pg.Client` gets one driver per object, built once and reused.
 *
 * steve never calls `close()` on a driver: that would end the host's pool or client.
 *
 * @throws {TypeError} If `db` is missing, or a `Driver` of another dialect
 */
export function toDriver(db: SteveDb): Driver {
	if (typeof db !== "object" || db === null) {
		throw new TypeError(
			`steve needs a database: 'db' must be a pg.Pool, a pg.Client or a sqlkit Driver`,
		);
	}
	if (isDriver(db)) {
		if (db.dialect !== "pg") {
			throw new TypeError(
				`steve runs on PostgreSQL: got a "${db.dialect}" driver (${db.adapter})`,
			);
		}
		return db;
	}
	let driver = drivers.get(db);
	if (driver === undefined) {
		driver = isPool(db) ? createPgDriver(db) : createPgClientDriver(db);
		drivers.set(db, driver);
	}
	return driver;
}
