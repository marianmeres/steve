import { JOB_STATUS, type JobContext } from "../jobs.ts";

/**
 * Will mark jobs which are still marked as "running" after `allowedDurationMinutes`
 * as expired (the may have crashed mid-job). This is just a cleanup.
 */
export async function _markExpired(
	context: JobContext,
	maxAllowedRunDurationMin = 5
): Promise<void> {
	const { db, tableNames } = context;
	const { tableJobs } = tableNames;

	await db.query(
		`UPDATE ${tableJobs} 
		SET status = '${JOB_STATUS.EXPIRED}', 
			updated_at = NOW()
		WHERE status = '${JOB_STATUS.RUNNING}' 
			AND started_at < NOW() - INTERVAL '${maxAllowedRunDurationMin} minutes'`
	);
}
