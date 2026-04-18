import type pg from "pg";
import {
	Jobs,
	JOB_STATUS,
	type Job,
	type JobHandler,
} from "../src/mod.ts";
import { testsRunner } from "./_tests-runner.ts";
import { assert, assertEquals, assertRejects } from "@std/assert";
import { sleep } from "../src/steve/utils/sleep.ts";
import {
	isPool,
	withTransaction,
} from "../src/steve/utils/with-transaction.ts";

const tablePrefix = "_fixes_";
const pollTimeoutMs = 100;

function silentLogger() {
	return { debug: () => {}, error: () => {}, warn: () => {}, log: () => {} };
}

interface CreateJobsOptions {
	jobHandler?: JobHandler;
	// deno-lint-ignore no-explicit-any
	autoCleanup?: any;
	gracefulSigterm?: boolean;
}

async function _createJobs(db: pg.Client | pg.Pool, opts: CreateJobsOptions = {}) {
	const jobs = new Jobs({
		db,
		logger: silentLogger(),
		gracefulSigterm: opts.gracefulSigterm ?? false,
		pollTimeoutMs,
		tablePrefix,
		jobHandler: opts.jobHandler,
		autoCleanup: opts.autoCleanup,
	});
	await jobs.resetHard();
	return jobs;
}

/**
 * Small helper that awaits a condition with a small polling budget. Uses a single
 * timer at a time to keep Deno's resource-leak checker happy.
 */
async function waitFor(
	predicate: () => boolean | Promise<boolean>,
	{ timeoutMs = 1000, stepMs = 20 }: { timeoutMs?: number; stepMs?: number } = {}
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

testsRunner([
	// ---------------------------------------------------------------
	// C1 — transactions run on a single connection
	{
		name: "withTransaction: BEGIN/work/COMMIT all run on the same client",
		async fn({ db }) {
			assert(isPool(db));

			const commands: { clientIdx: number; sql: string }[] = [];
			const originalConnect = (db as pg.Pool).connect.bind(db);
			let clientCounter = 0;
			// deno-lint-ignore no-explicit-any
			(db as pg.Pool).connect = (async (...args: unknown[]) => {
				// deno-lint-ignore no-explicit-any
				const client = await (originalConnect as any)(...args);
				const idx = clientCounter++;
				const origQuery = client.query.bind(client);
				// deno-lint-ignore no-explicit-any
				(client as any).query = async (...qargs: unknown[]) => {
					commands.push({
						clientIdx: idx,
						sql: String(qargs[0]).trim().slice(0, 40),
					});
					// deno-lint-ignore no-explicit-any
					return await (origQuery as any)(...qargs);
				};
				return client;
				// deno-lint-ignore no-explicit-any
			}) as any;

			try {
				await withTransaction(db, async (client) => {
					await client.query("SELECT 1");
					await client.query("SELECT 2");
				});

				const clientIndexes = new Set(commands.map((c) => c.clientIdx));
				assertEquals(clientIndexes.size, 1, "all queries must share one client");
				const sqlTypes = commands.map((c) => c.sql.split(" ")[0]);
				assertEquals(sqlTypes[0], "BEGIN");
				assertEquals(sqlTypes[sqlTypes.length - 1], "COMMIT");
			} finally {
				// deno-lint-ignore no-explicit-any
				(db as pg.Pool).connect = originalConnect as any;
			}
		},
	},
	{
		name: "withTransaction: ROLLBACK on error",
		async fn({ db }) {
			const events: string[] = [];
			const originalConnect = (db as pg.Pool).connect.bind(db);
			// deno-lint-ignore no-explicit-any
			(db as pg.Pool).connect = (async (...args: unknown[]) => {
				// deno-lint-ignore no-explicit-any
				const client = await (originalConnect as any)(...args);
				const origQuery = client.query.bind(client);
				// deno-lint-ignore no-explicit-any
				(client as any).query = async (...args: unknown[]) => {
					events.push(String(args[0]).trim().split(" ")[0]);
					// deno-lint-ignore no-explicit-any
					return await (origQuery as any)(...args);
				};
				return client;
				// deno-lint-ignore no-explicit-any
			}) as any;

			try {
				await assertRejects(
					() =>
						withTransaction(db, async () => {
							throw new Error("boom");
						}),
					Error,
					"boom"
				);
				assert(events.includes("BEGIN"));
				assert(events.includes("ROLLBACK"));
				assert(!events.includes("COMMIT"));
			} finally {
				// deno-lint-ignore no-explicit-any
				(db as pg.Pool).connect = originalConnect as any;
			}
		},
	},

	// ---------------------------------------------------------------
	// C2 — hostile sinceMinutesAgo is coerced, no injection
	{
		name: "fetchAll: hostile sinceMinutesAgo is coerced without SQL injection",
		async fn({ db }) {
			const jobs = await _createJobs(db);
			await jobs.create("foo", {});

			const hostile = "1'; DROP TABLE does_not_exist; --";
			// deno-lint-ignore no-explicit-any
			const rows = await jobs.fetchAll(null, { sinceMinutesAgo: hostile as any });
			assert(Array.isArray(rows));

			// Tables must still exist and behave normally
			const after = await jobs.fetchAll();
			assert(Array.isArray(after));
			assert(after.length >= 1);
		},
	},

	// ---------------------------------------------------------------
	// C3 — instance-scoped event wraps
	{
		name: "onDone: two Jobs instances with the same callback are independent",
		async fn({ db }) {
			let aCount = 0;
			let bCount = 0;
			const cb = (j: Job) => {
				if (j.type === "a") aCount++;
				if (j.type === "b") bCount++;
			};

			// Two instances with DIFFERENT prefixes so they don't race over rows,
			// but share the same user callback.
			const jobsA = new Jobs({
				db,
				logger: silentLogger(),
				gracefulSigterm: false,
				pollTimeoutMs,
				tablePrefix: "_fixes_a_",
				jobHandler: () => ({}),
			});
			await jobsA.resetHard();

			const jobsB = new Jobs({
				db,
				logger: silentLogger(),
				gracefulSigterm: false,
				pollTimeoutMs,
				tablePrefix: "_fixes_b_",
				jobHandler: () => ({}),
			});
			await jobsB.resetHard();

			const unsubA = jobsA.onDone("a", cb);
			jobsB.onDone("b", cb);

			try {
				await jobsA.start(1);
				await jobsB.start(1);

				await jobsA.create("a", {});
				await jobsB.create("b", {});
				await waitFor(() => aCount === 1 && bCount === 1);

				assertEquals(aCount, 1);
				assertEquals(bCount, 1);

				// Unsubscribe from A; B must still work (regression-guard for the
				// static-wrap-map bug where this would tear down B's wrapper too).
				unsubA();

				await jobsB.create("b", {});
				await waitFor(() => bCount === 2);
				assertEquals(bCount, 2);
			} finally {
				await jobsA.stop();
				await jobsB.stop();
				jobsA.unsubscribeAll();
				jobsB.unsubscribeAll();
				await jobsA.uninstall();
				await jobsB.uninstall();
			}
		},
	},
	{
		name: "onDone: multi-type subscribe + unsubscribe cleanly drops listeners",
		async fn({ db }) {
			const jobs = await _createJobs(db, { jobHandler: () => ({}) });
			const log: string[] = [];
			const cb = (j: Job) => log.push(j.type);
			const unsubAll = jobs.onDone(["a", "b"], cb);

			try {
				await jobs.start(1);
				await jobs.create("a", {});
				await waitFor(() => log.length === 1);
				assertEquals(log, ["a"]);

				unsubAll();
				await jobs.create("b", {});
				// give it a window to (not) fire
				await waitFor(() => log.length === 2, { timeoutMs: 400 });
				assertEquals(log, ["a"]);
			} finally {
				await jobs.stop();
				jobs.unsubscribeAll();
			}
		},
	},
	{
		name: "unsubscribeAll clears internal wrap registry and allows re-subscribe",
		async fn({ db }) {
			const jobs = await _createJobs(db, { jobHandler: () => ({}) });
			const cb = (_j: Job) => {};
			jobs.onDone(["a", "b"], cb);
			jobs.unsubscribeAll();

			let fired = 0;
			jobs.onDone("a", () => fired++);

			try {
				await jobs.start(1);
				await jobs.create("a", {});
				await waitFor(() => fired === 1);
				assertEquals(fired, 1);
			} finally {
				await jobs.stop();
				jobs.unsubscribeAll();
			}
		},
	},

	// ---------------------------------------------------------------
	// C4 / H5 — expired reaper fires onDone and sets completed_at
	{
		name: "cleanup: reaps stuck-running jobs, sets completed_at, fires onDone",
		async fn({ db }) {
			const jobs = await _createJobs(db);
			let doneFires = 0;
			const expiredRef: { value: Job | null } = { value: null };
			jobs.onDone("crashed", (j: Job) => {
				doneFires++;
				if (j.status === JOB_STATUS.EXPIRED) expiredRef.value = j;
			});

			try {
				const created = await jobs.create("crashed", {});
				await db.query(
					`UPDATE ${tablePrefix}__job SET status = 'running',
						started_at = NOW() - INTERVAL '10 minutes',
						attempts = 1
					 WHERE id = $1`,
					[created.id]
				);

				const reaped = await jobs.cleanup(5);
				assertEquals(reaped, 1);
				assertEquals(doneFires, 1);
				assert(expiredRef.value);
				assertEquals(expiredRef.value.status, JOB_STATUS.EXPIRED);
				assert(expiredRef.value.completed_at);
			} finally {
				jobs.unsubscribeAll();
			}
		},
	},
	{
		name: "cleanup: respects threshold, not-stuck jobs untouched",
		async fn({ db }) {
			const jobs = await _createJobs(db);
			const created = await jobs.create("foo", {});
			await db.query(
				`UPDATE ${tablePrefix}__job SET status = 'running',
					started_at = NOW() - INTERVAL '2 minutes'
				 WHERE id = $1`,
				[created.id]
			);
			const reaped = await jobs.cleanup(5);
			assertEquals(reaped, 0);

			const found = await jobs.find(created.uid);
			assertEquals(found.job.status, JOB_STATUS.RUNNING);
		},
	},

	// ---------------------------------------------------------------
	// H1 — start() throws on init failure (not silent)
	{
		name: "start(): init failure bubbles up (no silent return)",
		async fn(_ctx) {
			const pgMod = (await import("pg")).default;
			const badDb = new pgMod.Pool({
				host: "127.0.0.1",
				port: 1,
				database: "nope",
				user: "nope",
				password: "nope",
				connectionTimeoutMillis: 500,
			});
			const jobs = new Jobs({
				db: badDb,
				logger: silentLogger(),
				gracefulSigterm: false,
				pollTimeoutMs: 1000,
				tablePrefix: "_bad_init_",
			});

			await assertRejects(() => jobs.start(1));
		},
		raw: true,
	},

	// ---------------------------------------------------------------
	// H2 — start() is idempotent
	{
		name: "start(): called twice does not double-spawn processors",
		async fn({ db }) {
			const jobs = await _createJobs(db, { jobHandler: () => ({}) });
			try {
				await jobs.start(2);
				await jobs.start(2);
				assertEquals(jobs.__debugDump().processorsCount, 2);
			} finally {
				await jobs.stop();
			}
		},
	},
	{
		name: "start()/stop()/start(): lifecycle can be repeated",
		async fn({ db }) {
			const jobs = await _createJobs(db, { jobHandler: () => ({}) });
			await jobs.start(1);
			await jobs.create("x", {});
			await waitFor(() => jobs.__debugDump().isRunning === true);
			await jobs.stop();
			assertEquals(jobs.__debugDump().isRunning, false);

			await jobs.start(1);
			assertEquals(jobs.__debugDump().isRunning, true);
			await jobs.stop();
		},
	},

	// ---------------------------------------------------------------
	// H3 — SIGTERM listener cleanup
	{
		name: "SIGTERM listener: added on start, removed on stop",
		async fn({ db }) {
			// deno-lint-ignore no-explicit-any
			const proc = (await import("node:process")).default as any;
			const baseline = proc.listenerCount("SIGTERM");

			const jobs = new Jobs({
				db,
				logger: silentLogger(),
				gracefulSigterm: true,
				pollTimeoutMs,
				tablePrefix,
				jobHandler: () => ({}),
			});
			await jobs.resetHard();

			try {
				await jobs.start(1);
				assertEquals(proc.listenerCount("SIGTERM"), baseline + 1);
			} finally {
				await jobs.stop();
			}
			assertEquals(proc.listenerCount("SIGTERM"), baseline);
		},
	},

	// ---------------------------------------------------------------
	// H4 — started_at preserved across retries
	{
		name: "started_at: preserved across retry attempts",
		async fn({ db }) {
			let attempts = 0;
			const ref = { id: -1 };
			const jobs = await _createJobs(db, {
				jobHandler: async (_j: Job) => {
					attempts++;
					await sleep(10, ref);
					if (attempts < 2) throw new Error("retry me");
					return { ok: true };
				},
			});

			try {
				const { uid } = await jobs.create(
					"foo",
					{},
					{ backoff_strategy: "none", max_attempts: 3 }
				);
				await jobs.start(1);
				await waitFor(async () => {
					const { job } = await jobs.find(uid);
					return job?.status === JOB_STATUS.COMPLETED;
				}, { timeoutMs: 2000 });

				const { job } = await jobs.find(uid);
				assertEquals(job.status, JOB_STATUS.COMPLETED);
				assertEquals(job.attempts, 2);
				const startDelayMs =
					new Date(job.started_at).valueOf() -
					new Date(job.created_at).valueOf();
				assert(
					startDelayMs < 500,
					`started_at delay ${startDelayMs}ms too large — was started_at reset on retry?`
				);
			} finally {
				await jobs.stop();
				jobs.unsubscribeAll();
				clearTimeout(ref.id);
			}
		},
	},

	// ---------------------------------------------------------------
	// H8 — AbortSignal fires on timeout
	{
		name: "AbortSignal: aborts on attempt timeout",
		async fn({ db }) {
			const abortedRef = { value: false };
			const ref = { id: -1 };
			const jobs = await _createJobs(db, {
				jobHandler: async (_j: Job, signal?: AbortSignal) => {
					signal?.addEventListener("abort", () => {
						abortedRef.value = true;
					});
					await sleep(500, ref);
				},
			});

			try {
				await jobs.create(
					"foo",
					{},
					{
						backoff_strategy: "none",
						max_attempts: 1,
						max_attempt_duration_ms: 50,
					}
				);
				await jobs.start(1);
				await waitFor(() => abortedRef.value, { timeoutMs: 2000 });
				assert(
					abortedRef.value,
					"handler must receive AbortSignal.abort on timeout"
				);
			} finally {
				await jobs.stop();
				jobs.unsubscribeAll();
				clearTimeout(ref.id);
			}
		},
	},

	// ---------------------------------------------------------------
	// H9 — invalid Date
	{
		name: "create(): invalid run_at throws TypeError with clear message",
		async fn({ db }) {
			const jobs = await _createJobs(db);
			await assertRejects(
				// deno-lint-ignore no-explicit-any
				() => jobs.create("foo", {}, { run_at: "not-a-date" as any }),
				TypeError,
				"Invalid 'run_at'"
			);
		},
	},

	// ---------------------------------------------------------------
	// H10 — backoff cap
	{
		name: "backoff: capped at 1 hour even at high attempt counts",
		async fn({ db }) {
			const jobs = await _createJobs(db);
			const created = await jobs.create(
				"foo",
				{},
				{ backoff_strategy: "exp", max_attempts: 100 }
			);

			await db.query(
				`UPDATE ${tablePrefix}__job SET status = 'running',
					attempts = 30, started_at = NOW()
				 WHERE id = $1`,
				[created.id]
			);
			const { rows: attemptRows } = await db.query(
				`INSERT INTO ${tablePrefix}__job_attempt_log (job_id, attempt_number)
				 VALUES ($1, 30) RETURNING id`,
				[created.id]
			);
			const attemptId = attemptRows[0].id;

			const { _handleJobFailure } = await import(
				"../src/steve/job/_handle-failure.ts"
			);
			const { rows: jobRows } = await db.query(
				`SELECT * FROM ${tablePrefix}__job WHERE id = $1`,
				[created.id]
			);

			// deno-lint-ignore no-explicit-any
			const context = {
				db,
				tableNames: {
					tableJobs: `${tablePrefix}__job`,
					tableAttempts: `${tablePrefix}__job_attempt_log`,
				},
				logger: silentLogger(),
			} as any;

			const failed = await _handleJobFailure(
				context,
				jobRows[0],
				attemptId,
				new Error("boom")
			);
			assertEquals(failed.status, JOB_STATUS.PENDING);
			const deltaMs =
				new Date(failed.run_at).valueOf() - Date.now();
			assert(
				deltaMs <= 60 * 60 * 1000 + 5_000,
				`backoff ${deltaMs}ms exceeds 1h cap`
			);
		},
	},

	// ---------------------------------------------------------------
	// L4 — hasHandler includes fallback
	{
		name: "hasHandler: returns true when only the global fallback handler is set",
		async fn({ db }) {
			const jobs = await _createJobs(db, { jobHandler: () => ({}) });
			assert(jobs.hasHandler("any-type"));
			jobs.resetHandlers();
			assertEquals(jobs.hasHandler("any-type"), false);
		},
	},

	// ---------------------------------------------------------------
	// autoCleanup
	{
		name: "autoCleanup: periodic reaper marks stuck-running jobs expired",
		async fn({ db }) {
			const jobs = await _createJobs(db, {
				autoCleanup: {
					intervalMs: 80,
					maxAllowedRunDurationMinutes: 0,
				},
			});

			const fires = { n: 0 };
			jobs.onDone("stuck", (j: Job) => {
				if (j.status === JOB_STATUS.EXPIRED) fires.n++;
			});

			try {
				const created = await jobs.create("stuck", {});
				await db.query(
					`UPDATE ${tablePrefix}__job SET status = 'running',
						started_at = NOW() - INTERVAL '1 minute', attempts = 1
					 WHERE id = $1`,
					[created.id]
				);

				await jobs.start(1);
				await waitFor(() => fires.n >= 1, { timeoutMs: 1500 });
				assert(fires.n >= 1, "autoCleanup must fire onDone for expired jobs");
			} finally {
				await jobs.stop();
				jobs.unsubscribeAll();
			}
		},
	},
]);
