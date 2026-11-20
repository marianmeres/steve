import { test } from "node:test";
import type pg from "pg";
import { createPg } from "./_pg.ts";

/** A test's ceiling unless it sets its own `timeoutMs`. */
const DEFAULT_TIMEOUT_MS = 30_000;

/** How long the teardown gives each tracked `stop()`. */
const STOP_TIMEOUT_MS = 5_000;

interface Stoppable {
	stop(): unknown;
}

const tracked = new Set<Stoppable>();

/**
 * Registers `instance` (a `Jobs`, anything with `stop()`) to be stopped when the current
 * test ends, however it ends: passed, failed, or over its ceiling. A started instance
 * left running keeps its processors polling, so the test file never exits and the suite
 * hangs instead of failing. Every test that starts one tracks it.
 */
export function track<T extends Stoppable>(instance: T): T {
	tracked.add(instance);
	return instance;
}

/** `promise`, or a rejection with `message` after `ms`; the timer never outlives it. */
async function within<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
	let id: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		id = setTimeout(() => reject(new Error(message)), ms);
	});
	try {
		return await Promise.race([promise, timeout]);
	} finally {
		clearTimeout(id);
	}
}

/** Stops every tracked instance, then ends the pool; returns what failed. */
async function teardown(db: pg.Pool | null): Promise<unknown[]> {
	const errors: unknown[] = [];
	const instances = [...tracked];
	tracked.clear();
	for (const instance of instances) {
		try {
			await within(
				Promise.resolve(instance.stop()),
				STOP_TIMEOUT_MS,
				`teardown: stop() did not return within ${STOP_TIMEOUT_MS} ms`,
			);
		} catch (e) {
			errors.push(e);
		}
	}
	try {
		await db?.end();
	} catch (e) {
		errors.push(e);
	}
	return errors;
}

export function testsRunner(
	tests: {
		name: string;
		fn: (ctx: { db: pg.Pool | pg.Client }) => void | Promise<void>;
		only?: boolean;
		ignore?: boolean;
		/** No pool is created: `db` is null and the test brings its own database. */
		raw?: boolean;
		/** The test fails, and is torn down, once it runs longer (default 30 s). */
		timeoutMs?: number;
	}[],
) {
	for (const def of tests) {
		const { name, ignore, only, timeoutMs = DEFAULT_TIMEOUT_MS } = def;
		if (typeof def.fn !== "function") continue;
		test(name, { skip: ignore, only }, async () => {
			const db = def.raw ? null : createPg();
			let failed = false;
			let failure: unknown;
			try {
				await within(
					Promise.resolve().then(() =>
						def.fn({ db: db ?? (null as unknown as pg.Pool) }),
					),
					timeoutMs,
					`test did not finish within ${timeoutMs} ms`,
				);
			} catch (e) {
				failed = true;
				failure = e;
			}
			const errors = await teardown(db);
			// The test's own failure is the one worth reading; a teardown failure only
			// fails a test that otherwise passed.
			if (failed) throw failure;
			if (errors.length === 1) throw errors[0];
			if (errors.length > 1) throw new AggregateError(errors, "teardown failed");
		});
	}
}
