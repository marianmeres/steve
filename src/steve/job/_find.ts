import { parseBoolean } from "@marianmeres/parse-boolean";
import { and, EMPTY, inList, raw, sql } from "@marianmeres/sqlkit";
import type { Job, JobContext } from "../jobs.ts";

/** Coerce a possibly-hostile value into a non-negative integer number of minutes. */
function coerceMinutes(v: unknown, fallback: number): number {
	const n = Number(v);
	if (!Number.isFinite(n)) return fallback;
	return Math.max(0, Math.trunc(n));
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Internal select one (optional tenant guard).
 *
 * `uid` is bound, but the column is `UUID`: a malformed value would make Postgres
 * raise "invalid input syntax for type uuid" instead of returning no row. It is
 * treated as a plain not-found so `find()` is safe to call with untrusted ids.
 */
export async function _find(
	context: JobContext,
	uid: string,
	tenantId: string | null = null,
): Promise<Job | undefined> {
	const { db, tableNames } = context;
	const { tableJobs } = tableNames;

	if (typeof uid !== "string" || !UUID_RE.test(uid)) return undefined;

	const tenantPredicate = tenantId == null ? EMPTY : sql`AND tenant_id = ${tenantId}`;

	const { rows } = await db.query<Job>(
		sql`SELECT * FROM ${raw(tableJobs)} WHERE uid = ${uid} ${tenantPredicate}`,
	);
	return rows[0];
}

/**
 * Internal select all. Both lists are bound, one value each; an empty or missing list
 * is no filter.
 */
export async function _fetchAll(
	context: JobContext,
	statuses: readonly string[] | null | undefined = null,
	tenantIds: readonly string[] | null | undefined = null,
	options: Partial<{
		limit: number | string;
		offset: number | string;
		asc: number | string | boolean;
		sinceMinutesAgo: number;
	}> = {},
): Promise<Job[]> {
	const { limit = 10, offset = 0, asc = false, sinceMinutesAgo = 30 } = options || {};

	const { db, tableNames } = context;
	const { tableJobs } = tableNames;

	// Bound, but coerced to a plain integer regardless of the declared TS type (TS is
	// erased at runtime), so a hostile value cannot fail the `::bigint` cast.
	const since = coerceMinutes(sinceMinutesAgo, 30);

	// The time window is always there, so `and()` never comes back empty.
	const where = and(
		statuses?.length ? sql`status IN ${inList(statuses)}` : EMPTY,
		tenantIds?.length ? sql`tenant_id IN ${inList(tenantIds)}` : EMPTY,
		sql`created_at > NOW() - (${since}::bigint || ' minutes')::interval`,
	);

	// Only code-owned text goes through `raw()`: the table name and the keyword.
	const { rows } = await db.query<Job>(sql`
		SELECT * FROM ${raw(tableJobs)}
		WHERE ${where}
		ORDER BY id ${raw(parseBoolean(asc) ? "asc" : "desc")}
		LIMIT ${limit} OFFSET ${offset}`);

	return rows;
}
