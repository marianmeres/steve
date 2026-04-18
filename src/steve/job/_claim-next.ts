import { type JobContext, JOB_STATUS } from "../jobs.ts";

/**
 * Atomically marks the next pending, ready-to-run job as running and returns it.
 *
 * - `ORDER BY run_at, id` gives FIFO fairness for jobs sharing a `run_at`, and
 *   respects scheduled delays ahead of creation order.
 * - `FOR UPDATE SKIP LOCKED` lets multiple workers claim different rows concurrently.
 * - `started_at` uses `COALESCE` so it records the FIRST attempt start (retries don't
 *   reset it).
 */
export async function _claimNextJob(context: JobContext) {
	const { db, tableNames } = context;
	const { tableJobs } = tableNames;

	const result = await db.query(`
		UPDATE ${tableJobs}
		SET status = '${JOB_STATUS.RUNNING}',
			started_at = COALESCE(started_at, NOW()),
			updated_at = NOW(),
			attempts = attempts + 1
		WHERE id = (
			SELECT id FROM ${tableJobs}
			WHERE status = '${JOB_STATUS.PENDING}'
			AND run_at <= NOW()
			ORDER BY run_at, id
			FOR UPDATE SKIP LOCKED -- Important!
			LIMIT 1
		)
		RETURNING *`);

	return result.rows[0];
}
