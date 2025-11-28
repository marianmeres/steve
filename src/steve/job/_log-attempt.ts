import {
	ATTEMPT_STATUS,
	type Job,
	type JobAttempt,
	type JobContext,
} from "../jobs.ts";

/**  */
export async function _logAttemptStart(
	context: JobContext,
	job: Job
): Promise<number> {
	const { db, tableNames } = context;
	const { tableAttempts } = tableNames;

	const { rows } = await db.query(
		`INSERT INTO ${tableAttempts} (job_id, attempt_number)
		VALUES ($1, $2)
		RETURNING id`,
		[job.id, job.attempts]
	);

	return rows[0].id as number;
}

/**  */
export async function _logAttemptSuccess(
	context: JobContext,
	attemptId: number
) {
	const { db, tableNames } = context;
	const { tableAttempts } = tableNames;

	await db.query(
		`UPDATE ${tableAttempts}
		SET status = '${ATTEMPT_STATUS.SUCCESS}', 
			completed_at = NOW()
		WHERE id = $1`,
		[attemptId]
	);
}

/**  */
export async function _logAttemptError(
	context: JobContext,
	attemptId: number,
	errMessage: string,
	errDetails: any
): Promise<void> {
	const { db, tableNames } = context;
	const { tableAttempts } = tableNames;

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

/**  */
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
