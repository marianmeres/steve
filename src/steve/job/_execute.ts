import {
	JOB_STATUS,
	type Job,
	type JobContext,
	type JobHandler,
} from "../jobs.ts";
import { _handleJobSuccess } from "./_handle-success.ts";
import { _handleJobFailure } from "./_handle-failure.ts";
import { _logAttemptStart } from "./_log-attempt.ts";
import { _publishAttempt, _publishDone } from "./_events.ts";
import { withTimeout } from "../utils/with-timeout.ts";

export async function _executeJob(
	context: JobContext,
	job: Job,
	handler: JobHandler
) {
	const { tableNames, logger } = context;
	const attemptId = await context.withRetry(() =>
		_logAttemptStart(context.db, tableNames.tableAttempts, job)
	);

	// publish the "running" state as an attempt (so every state change is observable)
	_publishAttempt(context, job);

	// ONLY the handler is covered by this try/catch. Finalization and consumer
	// callbacks live outside it, so a failure there can never be misattributed to the
	// job (which used to flip an already-COMPLETED job back to PENDING and re-run it).
	let ok = false;
	let result: unknown;
	let error: unknown;
	try {
		const run =
			job.max_attempt_duration_ms > 0
				? withTimeout(
						(signal) => handler(job, signal),
						job.max_attempt_duration_ms,
						"Execution timed out"
				  )
				: () => Promise.resolve().then(() => handler(job));
		result = await run();
		ok = true;
	} catch (e) {
		error = e;
	}

	// Finalization is retry-wrapped — transient DB blips during the write-path
	// should not leave the job inconsistent.
	const finalized = ok
		? await context.withRetry(() =>
				_handleJobSuccess(context, job, attemptId, result)
		  )
		: await context.withRetry(() =>
				_handleJobFailure(context, job, attemptId, error)
		  );

	if (!finalized) {
		// The row is no longer `running` on OUR attempt — somebody else finalized it in
		// the meantime (typically the reaper marked it `expired`). The attempt log row was
		// still written; the terminal state and its already-published onDone are left alone.
		logger?.warn?.(
			`Job ${job.id} (attempt ${job.attempts}) finished with ${
				ok ? "success" : "error"
			} after it was already finalized elsewhere — leaving its terminal state untouched.`
		);
		return;
	}

	// publish every finalized attempt (completed, failed, or pending = planned retry)
	_publishAttempt(context, finalized);

	// and the terminal states
	if (
		finalized.status === JOB_STATUS.COMPLETED ||
		finalized.status === JOB_STATUS.FAILED
	) {
		_publishDone(context, finalized);
	}
}
