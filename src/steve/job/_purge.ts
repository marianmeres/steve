import type { Job, JobContext } from "../jobs.ts";

/**
 * Only terminal statuses may be purged — never `pending` or `running`.
 *
 * Spelled as literals on purpose: this module is imported by jobs.ts, so reading
 * `JOB_STATUS` at module top level would hit the circular-import TDZ.
 */
export const PURGEABLE_STATUSES: readonly Job["status"][] = [
	"completed",
	"failed",
	"expired",
];

/**
 * Delete terminal jobs older than `olderThanMinutes` (measured on `completed_at`,
 * falling back to `updated_at` for legacy rows). Attempt-log rows go with them via the
 * `ON DELETE CASCADE` foreign key. Returns the number of jobs deleted.
 *
 * Every caller-supplied value is bound, never interpolated.
 */
export async function _purge(
	context: JobContext,
	olderThanMinutes: number,
	statuses: Job["status"][],
	tenantIds: string[] | null = null
): Promise<number> {
	const { db, tableNames } = context;
	const { tableJobs } = tableNames;

	const num = Number.isFinite(+olderThanMinutes)
		? Math.max(0, Math.round(+olderThanMinutes))
		: NaN;
	if (Number.isNaN(num)) {
		throw new TypeError(`'olderThanMinutes' must be a finite number`);
	}

	const wanted = [...new Set(statuses)];
	const invalid = wanted.filter((s) => !PURGEABLE_STATUSES.includes(s));
	if (!wanted.length || invalid.length) {
		throw new TypeError(
			`purge: only terminal statuses (${PURGEABLE_STATUSES.join(", ")}) can be purged` +
				(invalid.length ? `, got: ${invalid.join(", ")}` : "")
		);
	}

	const params: unknown[] = [num, wanted];
	let tenantPredicate = "";
	if (tenantIds && tenantIds.length) {
		params.push(tenantIds);
		tenantPredicate = `AND tenant_id = ANY($${params.length}::varchar[])`;
	}

	const { rowCount } = await db.query(
		`DELETE FROM ${tableJobs}
		WHERE status = ANY($2::varchar[])
			AND COALESCE(completed_at, updated_at) < NOW() - ($1::bigint || ' minutes')::interval
			${tenantPredicate}`,
		params
	);

	return rowCount ?? 0;
}
