import type { Job, JobAwareFn, JobContext } from "../jobs.ts";

/**
 * Invoke a consumer callback so that neither a synchronous throw nor an async
 * rejection can escape into the job lifecycle. Errors are logged and dropped.
 *
 * The type-keyed pubsub subscribers are already wrapped this way in `Jobs.#onEvent`;
 * this is the equivalent guard for the per-uid callbacks (`onDoneFor`, `onAttemptFor`,
 * `create(..., onDone)`).
 */
export function _safeInvoke(
	context: Pick<JobContext, "logger">,
	cb: JobAwareFn,
	job: Job,
	label: string
): void {
	const report = (e: unknown) =>
		context.logger?.error?.(`${label} callback (job ${job.uid}): ${e}`);
	try {
		const r = cb(job);
		if (r && typeof (r as Promise<void>).then === "function") {
			(r as Promise<void>).then(undefined, report);
		}
	} catch (e) {
		report(e);
	}
}

/** Publish an attempt-level state change (type-keyed pubsub + per-uid callbacks). */
export function _publishAttempt(context: JobContext, job: Job): void {
	context.pubsubAttempt.publish(job.type, job);
	const perUid = context.onAttemptCallbacks.get(job.uid);
	if (perUid) for (const cb of perUid) _safeInvoke(context, cb, job, "onAttempt");
}

/**
 * Publish a terminal state (`completed` / `failed` / `expired`): type-keyed pubsub +
 * per-uid callbacks, then drop the per-uid registrations for this job (one-shot).
 */
export function _publishDone(context: JobContext, job: Job): void {
	context.pubsubDone.publish(job.type, job);
	const perUid = context.onDoneCallbacks.get(job.uid);
	if (perUid) for (const cb of perUid) _safeInvoke(context, cb, job, "onDone");
	context.onDoneCallbacks.delete(job.uid);
	context.onAttemptCallbacks.delete(job.uid);
}
