import {
	JOB_STATUS,
	type Job,
	type JobContext,
	type JobHandler,
} from "../jobs.ts";
import { _handleJobSuccess } from "./_handle-success.ts";
import { _handleJobFailure } from "./_handle-failure.ts";
import { _logAttemptStart } from "./_log-attempt.ts";
import { withTimeout } from "../utils/with-timeout.ts";

export async function _executeJob(
	context: JobContext,
	job: Job,
	handler: JobHandler
) {
	const { tableNames } = context;
	const attemptId = await context.withRetry(() =>
		_logAttemptStart(context.db, tableNames.tableAttempts, job)
	);

	// we also need to publish "running" state as attempt (so we can track every state change effectively)
	context.pubsubAttempt.publish(job.type, job);

	context.onAttemptCallbacks.get(job.uid)?.forEach((cb) => cb(job));

	try {
		let __handler: () => Promise<unknown>;

		if (job.max_attempt_duration_ms > 0) {
			__handler = withTimeout(
				(signal) => handler(job, signal),
				job.max_attempt_duration_ms,
				"Execution timed out"
			);
		} else {
			__handler = async () => handler(job);
		}

		const result = await __handler();

		// Finalization is retry-wrapped — transient DB blips during the write-path
		// should not leave the job inconsistent.
		const completedJob = await context.withRetry(() =>
			_handleJobSuccess(context, job.id, attemptId, result)
		);

		context.pubsubAttempt.publish(job.type, completedJob);
		context.onAttemptCallbacks.get(job.uid)?.forEach((cb) => cb(completedJob));
		_execOnDone(context, completedJob);
	} catch (error) {
		const failedJob = await context.withRetry(() =>
			_handleJobFailure(context, job, attemptId, error)
		);
		// publish every failed attempt (which may be a retry)
		context.pubsubAttempt.publish(job.type, failedJob);
		context.onAttemptCallbacks.get(job.uid)?.forEach((cb) => cb(failedJob));

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
	context.onDoneCallbacks.get(job.uid)?.forEach((cb) => cb(job));

	// cleanup
	context.onDoneCallbacks.delete(job.uid);
	context.onAttemptCallbacks.delete(job.uid);
}
