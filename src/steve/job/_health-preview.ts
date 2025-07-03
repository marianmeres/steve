// deno-lint-ignore-file no-explicit-any

import type { JobContext } from "../jobs.ts";

/** Will collect some basic stats about the jobs since `sinceHours` */
export async function _healthPreview(
	context: JobContext,
	sinceMinutesAgo = 60
): Promise<any[]> {
	const { db, tableNames } = context;
	const { tableJobs } = tableNames;

	sinceMinutesAgo = parseInt(`${sinceMinutesAgo}`);
	if (Number.isNaN(sinceMinutesAgo)) {
		sinceMinutesAgo = 60;
	}

	const { rows } = await db.query(
		`SELECT 
			status, 
			COUNT(*) as count,
			AVG(EXTRACT(EPOCH FROM (completed_at - started_at))) as avg_duration_seconds
		FROM ${tableJobs}  
		WHERE created_at > NOW() - INTERVAL '${sinceMinutesAgo} minute'
		GROUP BY status;`
	);

	return rows;
}
