import {
	JOB_STATUS,
	type Job,
	type JobContext,
	type JobHandler,
} from "../jobs.ts";
import { _handleJobSuccess } from "./_handle-success.ts";
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
		const completedJob = await _handleJobSuccess(
			context,
			job.id,
			attemptId,
			result
		); // TX

		context.pubsubAttempt.publish(job.type, completedJob);
		_execOnDone(context, completedJob);
	} catch (error) {
		const failedJob = await _handleJobFailure(context, job, attemptId, error); // TX
		// publish every failed attempt (which may be a retry)
		context.pubsubAttempt.publish(job.type, failedJob);

		// also, true failure
		if (failedJob?.status === JOB_STATUS.FAILED) {
			_execOnDone(context, failedJob);
		}
	}
}

//
function _execOnDone(context: JobContext, job: Job) {
	context.pubsubDone.publish(job.type, job);

	// call the callback (if exists)
	context.onDoneCallbacks.get(job.uid)?.(job);

	// cleanup
	context.onDoneCallbacks.delete(job.uid);
}
