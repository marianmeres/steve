// deno-lint-ignore-file no-explicit-any

import type { JobContext } from "../jobs.ts";

/** Will collect some basic stats about the jobs since `sinceHours` */
export async function _healthPreview(
	context: JobContext,
	sinceHours = 1
): Promise<any[]> {
	const { db, tableNames } = context;
	const { tableJobs } = tableNames;

	const { rows } = await db.query(
		`SELECT 
			status, 
			COUNT(*) as count,
			AVG(EXTRACT(EPOCH FROM (completed_at - started_at))) as avg_duration_seconds
		FROM ${tableJobs}  
		WHERE created_at > NOW() - INTERVAL '${sinceHours} hour'
		GROUP BY status;`
	);

	return rows;
}
