import { type JobContext } from "../jobs.ts";

/**
 * Will mark jobs which are still marked as "running" after `allowedDurationMinutes`
 * as expired (the may have crashed mid-job). This is just a cleanup.
 */
export async function _healhPreview(
	context: JobContext,
	sinceHours = 1
): Promise<void> {
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
