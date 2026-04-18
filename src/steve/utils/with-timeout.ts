/** Error used in the Promise.race rejection */
export class TimeoutError extends Error {}

/**
 * Wraps `fn` in a timeout. Returns a thunk that, when called, starts the clock.
 *
 * On timeout the returned promise rejects with a `TimeoutError` AND `AbortController.abort()`
 * is called so cooperative handlers can bail out early. Note: JavaScript cannot forcibly
 * cancel a running promise; a handler that ignores the signal will continue to run in the
 * background until it finishes on its own.
 */
export function withTimeout<T>(
	fn: (signal: AbortSignal) => T | Promise<T>,
	timeout: number = 1_000,
	errMessage?: string
): () => Promise<T> {
	return () => {
		const ac = new AbortController();
		let _timeoutId: ReturnType<typeof setTimeout>;

		const _clock = new Promise<never>((_, reject) => {
			_timeoutId = setTimeout(() => {
				ac.abort();
				reject(new TimeoutError(errMessage || `Timed out after ${timeout} ms`));
			}, timeout);
		});

		return Promise.race([Promise.resolve().then(() => fn(ac.signal)), _clock])
			.finally(() => clearTimeout(_timeoutId));
	};
}
