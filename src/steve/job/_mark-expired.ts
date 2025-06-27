import { JOB_STATUS, type JobContext } from "../jobs.ts";

/**
 * Will mark jobs which are "running" too long as expired (the may have crashed mid-job).
 * This is just a cleanup (the inaccurate "running" state has no effect on the system).
 *
 * We could restart (mark them as pending) them instead, but that might create confusion
 * later as the actual job (whatever it is doing) may have become obsolete in the meantime.
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
