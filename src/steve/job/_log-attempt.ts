import { type Driver, json, raw, sql } from "@marianmeres/sqlkit";
import { ATTEMPT_STATUS, type Job, type JobAttempt, type JobContext } from "../jobs.ts";

/** Insert a new attempt row (status left NULL until the attempt completes). */
export async function _logAttemptStart(
	db: Driver,
	tableAttempts: string,
	job: Job,
): Promise<number> {
	// `job.attempts` is 1-based post-claim (see _claim-next.ts), so it matches
	// the sequential attempt_number we want to record here.
	const { rows } = await db.query<{ id: number }>(
		sql`INSERT INTO ${raw(tableAttempts)} (job_id, attempt_number)
		VALUES (${job.id}, ${job.attempts})
		RETURNING id`,
	);

	// INSERT … RETURNING answers exactly one row.
	return (rows[0] as { id: number }).id;
}

/** Mark an attempt row as successful. */
export async function _logAttemptSuccess(
	db: Driver,
	tableAttempts: string,
	attemptId: number,
): Promise<void> {
	await db.query(
		sql`UPDATE ${raw(tableAttempts)}
		SET status = ${ATTEMPT_STATUS.SUCCESS},
			completed_at = NOW()
		WHERE id = ${attemptId}`,
	);
}

/** Mark an attempt row as errored and store error message + details. */
export async function _logAttemptError(
	db: Driver,
	tableAttempts: string,
	attemptId: number,
	errMessage: string,
	errDetails: Record<string, string> | null,
): Promise<void> {
	// `json(null)` binds SQL NULL, as before.
	await db.query(
		sql`UPDATE ${raw(tableAttempts)}
		SET status = ${ATTEMPT_STATUS.ERROR},
			completed_at = NOW(),
			error_message = ${errMessage},
			error_details = ${json(errDetails)}
		WHERE id = ${attemptId}`,
	);
}

/** Fetch all attempts for a given job, oldest first. */
export async function _logAttemptFetchAll(
	context: JobContext,
	jobId: number,
): Promise<JobAttempt[]> {
	const { db, tableNames } = context;
	const { tableAttempts } = tableNames;
	const { rows } = await db.query<JobAttempt>(
		sql`SELECT * FROM ${raw(tableAttempts)} WHERE job_id = ${jobId} ORDER BY id asc`,
	);

	return rows;
}
