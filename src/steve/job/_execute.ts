// deno-lint-ignore-file no-explicit-any

import type { Job, JobContext, JobHandler } from "../jobs.ts";
import { _completeJob } from "./_complete.ts";
import { _handleJobFailure } from "./_handle-failure.ts";
import { _logAttemptStart } from "./_log-attempt.ts";

export async function _executeJob(
	context: JobContext,
	job: Job,
	handler: JobHandler
) {
	const attemptId = await _logAttemptStart(context, job);

	try {
		await handler(job);
		await _completeJob(context, job.id, attemptId);
	} catch (error) {
		await _handleJobFailure(context, job, attemptId, error);
	}
}
