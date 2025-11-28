import { type Job, JOB_STATUS, type JobContext } from "../jobs.ts";
import { _logAttemptSuccess } from "./_log-attempt.ts";

/** Will mark the job as completed and log success. */
export async function _handleJobSuccess(
	context: JobContext,
	jobId: number,
	attemptId: number,
	result: any
): Promise<Job> {
	const { db, tableNames } = context;
	const { tableJobs } = tableNames;

	await db.query("BEGIN");

	try {
		result = JSON.stringify(result ?? {});
	} catch (e) {
		result = {
			message: `Unable to serialize completed job result`,
			details: `${e}`,
		};
	}

	const job = (
		await db.query(
			`UPDATE ${tableJobs}
			SET status = '${JOB_STATUS.COMPLETED}', 
				completed_at = NOW(), 
				updated_at = NOW(),
				result = $1
			WHERE id = $2
			RETURNING *`,
			[result, jobId]
		)
	).rows[0];

	await _logAttemptSuccess(context, attemptId);

	await db.query("COMMIT");

	return job as Job;
}
