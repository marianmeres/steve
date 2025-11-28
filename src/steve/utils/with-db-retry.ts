import type { Logger } from "@marianmeres/clog";
import { sleep } from "./sleep.ts";

export interface DbRetryOptions {
	maxRetries?: number;
	initialDelayMs?: number;
	maxDelayMs?: number;
	backoffMultiplier?: number;
	retryableErrors?: string[]; // error codes to retry
	logger?: Logger;
}

const DEFAULT_RETRYABLE_ERRORS = [
	"ECONNREFUSED",
	"ECONNRESET",
	"ETIMEDOUT",
	"ENOTFOUND",
	"57P03", // PG: cannot_connect_now
	"08006", // PG: connection_failure
	"08003", // PG: connection_does_not_exist
	"08000", // PG: connection_exception
];

/**
 * Wraps a database operation with exponential backoff retry logic
 */
export async function withDbRetry<T>(
	fn: () => Promise<T>,
	options: DbRetryOptions = {}
): Promise<T> {
	const {
		maxRetries = 3,
		initialDelayMs = 100,
		maxDelayMs = 5000,
		backoffMultiplier = 2,
		retryableErrors = DEFAULT_RETRYABLE_ERRORS,
		logger,
	} = options;

	let lastError: any;
	let delayMs = initialDelayMs;

	for (let attempt = 0; attempt <= maxRetries; attempt++) {
		try {
			return await fn();
		} catch (error: any) {
			lastError = error;

			// Check if error is retryable
			const errorCode = error?.code;
			const isRetryable = retryableErrors.some(
				(code) => errorCode === code || error?.message?.includes(code)
			);

			// Don't retry on last attempt or non-retryable errors
			if (attempt === maxRetries || !isRetryable) {
				throw error;
			}

			logger?.warn?.(
				`DB operation failed (attempt ${attempt + 1}/${maxRetries + 1}): ${
					errorCode || error?.message
				}. Retrying in ${delayMs}ms...`
			);

			// wait before retry
			await sleep(delayMs);

			// Exponential backoff
			delayMs = Math.min(delayMs * backoffMultiplier, maxDelayMs);
		}
	}

	throw lastError;
}
