import { sleep } from "../src/steve/utils/sleep.ts";

/**
 * Polls `predicate` until it holds or `timeoutMs` runs out, and says which: a test
 * waits for what it expects instead of sleeping a fixed time, then asserts the values
 * (so a timeout fails on the real ones). Also usable as a window for something that
 * must NOT happen: expect `false` back. One timer at a time, cleared on return.
 */
export async function waitFor(
	predicate: () => boolean | Promise<boolean>,
	{ timeoutMs = 2000, stepMs = 20 }: { timeoutMs?: number; stepMs?: number } = {},
): Promise<boolean> {
	const ref = { id: -1 };
	const deadline = Date.now() + timeoutMs;
	try {
		while (Date.now() < deadline) {
			if (await predicate()) return true;
			await sleep(stepMs, ref);
		}
		return await Promise.resolve(predicate());
	} finally {
		clearTimeout(ref.id);
	}
}
