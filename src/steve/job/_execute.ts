import {
	JOB_STATUS,
	type Job,
	type JobContext,
	type JobHandler,
} from "../jobs.ts";
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
		context.pubsubAttempt.publish(job.type, completedJob);
	} catch (error) {
		const failedJob = await _handleJobFailure(context, job, attemptId, error); // TX
		// publish every failed attempt (which may be a retry)
		context.pubsubAttempt.publish(job.type, failedJob);

		// also, true failure
		if (failedJob?.status === JOB_STATUS.FAILED) {
			context.pubsubFailure.publish(job.type, failedJob);
		}
	}
}
