// deno-lint-ignore-file no-explicit-any

import { JOB_STATUS, type Job, type JobContext } from "../jobs.ts";
import { _logAttemptError } from "./_log-attempt.ts";

export async function _handleJobFailure(
	context: JobContext,
	job: Job,
	attemptId: number,
	error: any
): Promise<void> {
	const { db, tableNames } = context;
	const { tableJobs } = tableNames;

	await db.query("BEGIN");

	await _logAttemptError(
		context,
		attemptId,
		error?.message ?? `${error}`,
		error?.stack ? { stack: error.stack } : null
	);

	if (job.attempts >= job.max_attempts) {
		// Max attempts reached - mark as failed
		await db.query(
			`UPDATE ${tableJobs}
			SET status = '${JOB_STATUS.FAILED}', 
				completed_at = NOW(), 
				updated_at = NOW()
			WHERE id = $1`,
			[job.id]
		);
	} else {
		// Schedule retry with exponential backoff
		const backoffMs = Math.pow(2, job.attempts) * 1000; // 2^attempts seconds
		await db.query(
			`UPDATE ${tableJobs}
			SET status = '${JOB_STATUS.PENDING}',
				run_at = NOW() + INTERVAL '${backoffMs} milliseconds',
				updated_at = NOW()
			WHERE id = $1`,
			[job.id]
		);
	}

	await db.query("COMMIT");
}
