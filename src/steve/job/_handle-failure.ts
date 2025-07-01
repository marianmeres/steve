// deno-lint-ignore-file no-explicit-any

import {
	BACKOFF_STRATEGY,
	JOB_STATUS,
	type Job,
	type JobContext,
} from "../jobs.ts";
import { _logAttemptError } from "./_log-attempt.ts";

export async function _handleJobFailure(
	context: JobContext,
	job: Job,
	attemptId: number,
	error: any
): Promise<Job | null> {
	const { db, tableNames } = context;
	const { tableJobs } = tableNames;

	await db.query("BEGIN");

	await _logAttemptError(
		context,
		attemptId,
		error?.message ?? `${error}`,
		error?.stack ? { stack: error.stack } : null
	);

	let failed = null;

	// max attempts reached - mark as failed
	if (job.attempts >= job.max_attempts) {
		// only here we know the job truly failed
		failed = (
			await db.query(
				`UPDATE ${tableJobs}
				SET status = '${JOB_STATUS.FAILED}', 
					completed_at = NOW(), 
					updated_at = NOW()
				WHERE id = $1
				RETURNING *`,
				[job.id]
			)
		).rows[0];
	}
	// schedule retry with exponential backoff
	else {
		let backoffMs = 0;
		let strategy = job.backoff_strategy;
		const whitelist = [BACKOFF_STRATEGY.EXP, BACKOFF_STRATEGY.NONE];
		const defaultStrategy = BACKOFF_STRATEGY.EXP;

		if (!whitelist.includes(strategy)) {
			context?.logger?.(
				`Unknown backoff strategy '${strategy}' (falling back to '${defaultStrategy}').`
			);
			strategy = defaultStrategy;
		}

		if (strategy === BACKOFF_STRATEGY.EXP) {
			backoffMs = Math.pow(2, job.attempts) * 1000; // 2^attempts seconds
		}

		failed = (
			await db.query(
				`UPDATE ${tableJobs}
				SET status = '${JOB_STATUS.PENDING}',
					run_at = NOW() + INTERVAL '${backoffMs} milliseconds',
					updated_at = NOW()
				WHERE id = $1
				RETURNING *`,
				[job.id]
			)
		).rows[0];
	}

	await db.query("COMMIT");

	return failed;
}
