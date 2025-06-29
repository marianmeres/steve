import { parseBoolean } from "@marianmeres/parse-boolean";
import type { Job, JobContext } from "../jobs.ts";

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
	}> = {}
): Promise<Job[]> {
	const { limit = 10, offset = 0, asc = false } = options || {};

	const { db, tableNames } = context;
	const { tableJobs } = tableNames;

	// WARN: where clause is expected to be sanitized here... this is not a userland input
	const sql = `
		SELECT * FROM ${tableJobs}
		WHERE TRUE ${where ? `AND (${where}) ` : ""}
		ORDER BY id ${parseBoolean(asc) ? "asc" : "desc"}
		LIMIT $1 OFFSET $2
	`;

	const { rows } = await db.query(sql, [limit, offset]);

	return rows as Job[];
}
