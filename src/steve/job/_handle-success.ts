import { type Job, JOB_STATUS, type JobContext } from "../jobs.ts";
import { _logAttemptSuccess } from "./_log-attempt.ts";
import { withTransaction } from "../utils/with-transaction.ts";

/** Will mark the job as completed and log success — atomically in one transaction. */
export async function _handleJobSuccess(
	context: JobContext,
	jobId: number,
	attemptId: number,
	result: unknown
): Promise<Job> {
	const { db, tableNames } = context;
	const { tableJobs, tableAttempts } = tableNames;

	let serialized: string;
	try {
		serialized = JSON.stringify(result ?? {});
	} catch (e) {
		serialized = JSON.stringify({
			message: `Unable to serialize completed job result`,
			details: `${e}`,
		});
	}

	return await withTransaction(db, async (client) => {
		const { rows } = await client.query(
			`UPDATE ${tableJobs}
			SET status = '${JOB_STATUS.COMPLETED}',
				completed_at = NOW(),
				updated_at = NOW(),
				result = $1
			WHERE id = $2
			RETURNING *`,
			[serialized, jobId]
		);

		await _logAttemptSuccess(client, tableAttempts, attemptId);

		return rows[0] as Job;
	});
}
