import { raw, sql } from "@marianmeres/sqlkit";
import { JOB_STATUS, type Job, type JobContext } from "../jobs.ts";
import { _logAttemptSuccess } from "./_log-attempt.ts";

/**
 * Will mark the job as completed and log success — atomically in one transaction.
 *
 * The job UPDATE is fenced on `status = 'running' AND attempts = <ours>`: if the row
 * was finalized by somebody else meanwhile (e.g. the reaper marked it `expired`), the
 * terminal state is left untouched and `null` is returned. The attempt log row is
 * written either way.
 */
export async function _handleJobSuccess(
	context: JobContext,
	job: Job,
	attemptId: number,
	result: unknown,
): Promise<Job | null> {
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

	return await db.transaction(async (tx) => {
		// `serialized` is already JSON text: bound as it is, never through `json()`,
		// which would store a JSON string holding JSON.
		const { rows } = await tx.query<Job>(
			sql`UPDATE ${raw(tableJobs)}
			SET status = ${JOB_STATUS.COMPLETED},
				completed_at = NOW(),
				updated_at = NOW(),
				result = ${serialized}
			WHERE id = ${job.id}
				AND status = ${JOB_STATUS.RUNNING}
				AND attempts = ${job.attempts}
			RETURNING *`,
		);

		await _logAttemptSuccess(tx, tableAttempts, attemptId);

		return rows[0] ?? null;
	});
}
