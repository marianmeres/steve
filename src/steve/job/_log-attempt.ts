import {
	ATTEMPT_STATUS,
	type Job,
	type JobAttempt,
	type JobContext,
} from "../jobs.ts";
import type { Queryable } from "../utils/with-transaction.ts";

/** Insert a new attempt row (status left NULL until the attempt completes). */
export async function _logAttemptStart(
	db: Queryable,
	tableAttempts: string,
	job: Job
): Promise<number> {
	const { rows } = await db.query(
		`INSERT INTO ${tableAttempts} (job_id, attempt_number)
		VALUES ($1, $2)
		RETURNING id`,
		// `job.attempts` is 1-based post-claim (see _claim-next.ts), so it matches
		// the sequential attempt_number we want to record here.
		[job.id, job.attempts]
	);

	return rows[0].id as number;
}

/** Mark an attempt row as successful. */
export async function _logAttemptSuccess(
	db: Queryable,
	tableAttempts: string,
	attemptId: number
): Promise<void> {
	await db.query(
		`UPDATE ${tableAttempts}
		SET status = '${ATTEMPT_STATUS.SUCCESS}',
			completed_at = NOW()
		WHERE id = $1`,
		[attemptId]
	);
}

/** Mark an attempt row as errored and store error message + details. */
export async function _logAttemptError(
	db: Queryable,
	tableAttempts: string,
	attemptId: number,
	errMessage: string,
	errDetails: Record<string, string> | null
): Promise<void> {
	await db.query(
		`UPDATE ${tableAttempts}
		SET status = '${ATTEMPT_STATUS.ERROR}',
			completed_at = NOW(),
			error_message = $1,
			error_details = $2
		WHERE id = $3`,
		[errMessage, errDetails ? JSON.stringify(errDetails) : null, attemptId]
	);
}

/** Fetch all attempts for a given job, oldest first. */
export async function _logAttemptFetchAll(
	context: JobContext,
	jobId: number
): Promise<JobAttempt[]> {
	const { db, tableNames } = context;
	const { tableAttempts } = tableNames;
	const { rows } = await db.query(
		`SELECT * FROM ${tableAttempts} WHERE job_id = $1 ORDER BY id asc`,
		[jobId]
	);

	return rows;
}
