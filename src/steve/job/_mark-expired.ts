import { type Job, JOB_STATUS, type JobContext } from "../jobs.ts";

/**
 * Mark jobs stuck in `running` longer than `maxAllowedRunDurationMinutes` as expired.
 *
 * "Stuck" is measured on the CURRENT attempt via `updated_at`: the claim sets it
 * (see _claim-next.ts) and nothing touches the row again until finalization, so for a
 * `running` row it is exactly "when this attempt started". Do NOT use `started_at`
 * here — it records the FIRST attempt's start (preserved across retries) and would
 * reap a legitimately running retry whose cumulative backoff timeline exceeds the
 * threshold.
 *
 * Running-for-too-long means the worker almost certainly crashed mid-job. We flip
 * them to `expired` (terminal — we don't auto-retry because the work may now be
 * stale) and set `completed_at` so timing queries behave correctly. A handler that
 * is in fact still running will find its row no longer `running` at finalization and
 * will leave the terminal state alone (see _execute.ts).
 *
 * Returns the affected rows so the caller can publish `onDone` events.
 */
export async function _markExpired(
	context: JobContext,
	maxAllowedRunDurationMinutes = 5,
	tenantIds: string[] | null = null
): Promise<Job[]> {
	const { db, tableNames } = context;
	const { tableJobs } = tableNames;
	const num = Number.isFinite(+maxAllowedRunDurationMinutes)
		? Math.max(0, Math.round(+maxAllowedRunDurationMinutes))
		: 5;

	const params: unknown[] = [num];
	let tenantPredicate = "";
	if (tenantIds && tenantIds.length) {
		params.push(tenantIds);
		tenantPredicate = `AND tenant_id = ANY($${params.length}::varchar[])`;
	}

	const { rows } = await db.query(
		`UPDATE ${tableJobs}
		SET status = '${JOB_STATUS.EXPIRED}',
			updated_at = NOW(),
			completed_at = NOW()
		WHERE status = '${JOB_STATUS.RUNNING}'
			AND updated_at < NOW() - ($1::bigint || ' minutes')::interval
			${tenantPredicate}
		RETURNING *`,
		params
	);

	return rows as Job[];
}
