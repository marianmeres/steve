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
		const result = await handler(job);
		const completedJob = await _completeJob(context, job.id, attemptId, result); // TX
		context.pubsubSuccess.publish(job.type, completedJob);
	} catch (error) {
		const failedJob = await _handleJobFailure(context, job, attemptId, error); // TX
		// publish only on truly failed, not on retries
		if (failedJob) {
			context.pubsubFailure.publish(job.type, failedJob);
		}
	}
}
