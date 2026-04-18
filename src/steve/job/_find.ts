import { parseBoolean } from "@marianmeres/parse-boolean";
import type { Job, JobContext } from "../jobs.ts";

/** Coerce a possibly-hostile value into a non-negative integer number of minutes. */
function coerceMinutes(v: unknown, fallback: number): number {
	const n = Number(v);
	if (!Number.isFinite(n)) return fallback;
	return Math.max(0, Math.trunc(n));
}

/** Internal select one */
export async function _find(context: JobContext, uid: string): Promise<Job> {
	const { db, tableNames } = context;
	const { tableJobs } = tableNames;

	const { rows } = await db.query(`SELECT * FROM ${tableJobs} WHERE uid = $1`, [
		uid,
	]);

	return rows[0] as Job;
}

/** Internal select all */
export async function _fetchAll(
	context: JobContext,
	where: string | null | undefined = null,
	options: Partial<{
		limit: number | string;
		offset: number | string;
		asc: number | string | boolean;
		sinceMinutesAgo: number;
	}> = {}
): Promise<Job[]> {
	const {
		limit = 10,
		offset = 0,
		asc = false,
		sinceMinutesAgo = 30,
	} = options || {};

	const { db, tableNames } = context;
	const { tableJobs } = tableNames;

	// `sinceMinutesAgo` is interpolated directly into SQL so it MUST be coerced
	// to a plain integer regardless of the declared TS type (TS is erased at runtime).
	const since = coerceMinutes(sinceMinutesAgo, 30);

	// WARN: `where` is built internally (see jobs.ts fetchAll) — NOT userland input.
	const sql = `
		SELECT * FROM ${tableJobs}
		WHERE TRUE ${where ? `AND (${where}) ` : ""}
			AND created_at > NOW() - ($1::bigint || ' minutes')::interval
		ORDER BY id ${parseBoolean(asc) ? "asc" : "desc"}
		LIMIT $2 OFFSET $3
	`;

	const { rows } = await db.query(sql, [since, limit, offset]);

	return rows as Job[];
}
