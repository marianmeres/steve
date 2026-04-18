import {
	BACKOFF_STRATEGY,
	JOB_STATUS,
	type Job,
	type JobContext,
} from "../jobs.ts";
import { _logAttemptError } from "./_log-attempt.ts";
import { withTransaction } from "../utils/with-transaction.ts";

/** Cap exponential backoff at 1 hour so high `max_attempts` don't produce absurd delays. */
const MAX_BACKOFF_MS = 60 * 60 * 1000;

export async function _handleJobFailure(
	context: JobContext,
	job: Job,
	attemptId: number,
	error: unknown
): Promise<Job> {
	const { db, tableNames } = context;
	const { tableJobs, tableAttempts } = tableNames;

	const errMessage = error instanceof Error ? error.message : String(error);
	const errStack = error instanceof Error && error.stack ? { stack: error.stack } : null;

	return await withTransaction(db, async (client) => {
		await _logAttemptError(client, tableAttempts, attemptId, errMessage, errStack);

		// max attempts reached - mark as failed
		if (job.attempts >= job.max_attempts) {
			const { rows } = await client.query(
				`UPDATE ${tableJobs}
				SET status = '${JOB_STATUS.FAILED}',
					completed_at = NOW(),
					updated_at = NOW()
				WHERE id = $1
				RETURNING *`,
				[job.id]
			);
			return rows[0] as Job;
		}

		// schedule retry with potential backoff
		let backoffMs = 0;
		let strategy = job.backoff_strategy;
		const whitelist = [BACKOFF_STRATEGY.EXP, BACKOFF_STRATEGY.NONE];
		const defaultStrategy = BACKOFF_STRATEGY.EXP;

		if (!whitelist.includes(strategy)) {
			context?.logger?.warn?.(
				`Unknown backoff strategy '${strategy}' (falling back to '${defaultStrategy}').`
			);
			strategy = defaultStrategy;
		}

		if (strategy === BACKOFF_STRATEGY.EXP) {
			backoffMs = Math.min(Math.pow(2, job.attempts) * 1000, MAX_BACKOFF_MS);
		}

		const { rows } = await client.query(
			`UPDATE ${tableJobs}
			SET status = '${JOB_STATUS.PENDING}',
				run_at = NOW() + ($1::bigint || ' milliseconds')::interval,
				updated_at = NOW()
			WHERE id = $2
			RETURNING *`,
			[backoffMs, job.id]
		);
		return rows[0] as Job;
	});
}
