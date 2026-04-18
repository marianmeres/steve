import { type Job, JOB_STATUS, type JobContext } from "../jobs.ts";

/**
 * Mark jobs stuck in `running` longer than `maxAllowedRunDurationMinutes` as expired.
 *
 * Running-for-too-long means the worker almost certainly crashed mid-job. We flip
 * them to `expired` (terminal — we don't auto-retry because the work may now be
 * stale) and set `completed_at` so timing queries behave correctly.
 *
 * Returns the affected rows so the caller can publish `onDone` events.
 */
export async function _markExpired(
	context: JobContext,
	maxAllowedRunDurationMinutes = 5
): Promise<Job[]> {
	const { db, tableNames } = context;
	const { tableJobs } = tableNames;
	const num = Number.isFinite(+maxAllowedRunDurationMinutes)
		? Math.max(0, Math.round(+maxAllowedRunDurationMinutes))
		: 5;

	const { rows } = await db.query(
		`UPDATE ${tableJobs}
		SET status = '${JOB_STATUS.EXPIRED}',
			updated_at = NOW(),
			completed_at = NOW()
		WHERE status = '${JOB_STATUS.RUNNING}'
			AND started_at < NOW() - ($1::bigint || ' minutes')::interval
		RETURNING *`,
		[num]
	);

	return rows as Job[];
}
