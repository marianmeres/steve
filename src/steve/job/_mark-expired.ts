import { JOB_STATUS, type JobContext } from "../jobs.ts";

/**
 * Will mark jobs which are "running" too long as expired (they may have crashed mid-job).
 * This is just a cleanup (the inaccurate "running" state has no effect on the system).
 *
 * Note: we could restart (mark as pending) them instead, but that might create confusion
 * later as the actual job (whatever it is doing) may have become obsolete in the meantime.
 */
export async function _markExpired(
	context: JobContext,
	maxAllowedRunDurationMinutes = 5
): Promise<void> {
	const { db, tableNames } = context;
	const { tableJobs } = tableNames;
	const num = Math.round(maxAllowedRunDurationMinutes);

	await db.query(
		`UPDATE ${tableJobs} 
		SET status = '${JOB_STATUS.EXPIRED}', 
			updated_at = NOW()
		WHERE status = '${JOB_STATUS.RUNNING}' 
			AND started_at < NOW() - INTERVAL '${num} minutes'`
	);
}
