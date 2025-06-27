import { JOB_STATUS, type JobContext } from "../jobs.ts";
import { _logAttemptSuccess } from "./_log-attempt.ts";

/** Will mark the job as completed and log success. */
export async function _completeJob(
	context: JobContext,
	jobId: number,
	attemptId: number
) {
	const { db, tableNames } = context;
	const { tableJobs } = tableNames;

	await db.query("BEGIN");

	await db.query(
		`UPDATE ${tableJobs}
		SET status = '${JOB_STATUS.COMPLETED}', 
			completed_at = NOW(), 
			updated_at = NOW()
		WHERE id = $1`,
		[jobId]
	);

	await _logAttemptSuccess(context, attemptId);

	await db.query("COMMIT");
}
