import assert from "node:assert/strict";
import { toPgDriver } from "@marianmeres/sqlkit/pg";
import pg from "pg";
import { JOB_STATUS, type Job, type JobHandler, Jobs } from "../src/index.ts";
import type { JobContext } from "../src/steve/jobs.ts";
import { sleep } from "../src/steve/utils/sleep.ts";
import { testsRunner, track } from "./_tests-runner.ts";
import { waitFor } from "./_wait.ts";

const tablePrefix = "_fixes_";
const pollTimeoutMs = 100;

function silentLogger() {
	return { debug: () => {}, error: () => {}, warn: () => {}, log: () => {} };
}

interface CreateJobsOptions {
	jobHandler?: JobHandler;
	// biome-ignore lint/suspicious/noExplicitAny: deliberately untyped test double / invalid input
	autoCleanup?: any;
	gracefulSigterm?: boolean;
}

async function _createJobs(db: pg.Client | pg.Pool, opts: CreateJobsOptions = {}) {
	const jobs = track(
		new Jobs({
			db,
			logger: silentLogger(),
			gracefulSigterm: opts.gracefulSigterm ?? false,
			pollTimeoutMs,
			tablePrefix,
			jobHandler: opts.jobHandler,
			autoCleanup: opts.autoCleanup,
		}),
	);
	await jobs.resetHard();
	return jobs;
}

testsRunner([
	// ---------------------------------------------------------------
	// C1 — transactions run on a single connection
	{
		name: "transactions: a finalization runs begin…commit on one pooled client",
		async fn({ db }) {
			assert(db instanceof pg.Pool);
			const jobs = await _createJobs(db, { jobHandler: () => ({ ok: true }) });

			// Record every statement with the index of the client it ran on. The pool
			// hands back the same object for the same connection, so wrap each one once.
			const statements: { clientIdx: number; sql: string }[] = [];
			const wrapped = new WeakSet<object>();
			let clientCounter = 0;
			const originalConnect = db.connect.bind(db);
			// biome-ignore lint/suspicious/noExplicitAny: deliberately untyped test double / invalid input
			(db as any).connect = async () => {
				const client = await originalConnect();
				if (!wrapped.has(client)) {
					wrapped.add(client);
					const idx = clientCounter++;
					const origQuery = client.query.bind(client);
					// biome-ignore lint/suspicious/noExplicitAny: deliberately untyped test double / invalid input
					(client as any).query = (q: any, ...rest: unknown[]) => {
						// sqlkit sends a config object; anything else may send text
						const sql = typeof q === "string" ? q : q.text;
						statements.push({ clientIdx: idx, sql: String(sql).trim() });
						// biome-ignore lint/suspicious/noExplicitAny: deliberately untyped test double / invalid input
						return (origQuery as any)(q, ...rest);
					};
				}
				return client;
			};

			try {
				// `onDone` rather than polling `find()`: no statement of the test's own
				// may run while the finalization's transaction is open.
				const done = new Promise<Job>((resolve) => {
					jobs.onDone("x", resolve);
				});
				await jobs.start(1);
				const created = await jobs.create("x", {}, { max_attempts: 1 });
				const finalized = await done;
				assert.deepEqual(finalized.uid, created.uid);
				assert.deepEqual(finalized.status, JOB_STATUS.COMPLETED);
				await jobs.stop();

				const is = (i: number, word: string) =>
					statements[i]!.sql.toLowerCase() === word;
				const update = statements.findIndex((s) =>
					/SET status = \$\d+,[\s\S]*result = \$\d+/i.test(s.sql),
				);
				assert(update > 0, "the finalization's UPDATE was recorded");
				let begin = update;
				while (begin >= 0 && !is(begin, "begin")) begin--;
				let commit = update;
				while (commit < statements.length && !is(commit, "commit")) commit++;
				assert(begin >= 0, "a begin precedes the finalization");
				assert(commit < statements.length, "a commit follows the finalization");

				const tx = statements.slice(begin, commit + 1);
				assert(
					tx.some((s) => /__job_attempt_log/.test(s.sql)),
					"the attempt log is written inside the same transaction",
				);
				assert.deepEqual(
					new Set(tx.map((s) => s.clientIdx)).size,
					1,
					"begin…commit must share one client",
				);
			} finally {
				// biome-ignore lint/suspicious/noExplicitAny: deliberately untyped test double / invalid input
				(db as any).connect = originalConnect;
				await jobs.stop();
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
			// biome-ignore lint/suspicious/noExplicitAny: deliberately untyped test double / invalid input
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
			const jobsA = track(
				new Jobs({
					db,
					logger: silentLogger(),
					gracefulSigterm: false,
					pollTimeoutMs,
					tablePrefix: "_fixes_a_",
					jobHandler: () => ({}),
				}),
			);
			await jobsA.resetHard();

			const jobsB = track(
				new Jobs({
					db,
					logger: silentLogger(),
					gracefulSigterm: false,
					pollTimeoutMs,
					tablePrefix: "_fixes_b_",
					jobHandler: () => ({}),
				}),
			);
			await jobsB.resetHard();

			const unsubA = jobsA.onDone("a", cb);
			jobsB.onDone("b", cb);

			try {
				await jobsA.start(1);
				await jobsB.start(1);

				await jobsA.create("a", {});
				await jobsB.create("b", {});
				await waitFor(() => aCount === 1 && bCount === 1);

				assert.deepEqual(aCount, 1);
				assert.deepEqual(bCount, 1);

				// Unsubscribe from A; B must still work (regression-guard for the
				// static-wrap-map bug where this would tear down B's wrapper too).
				unsubA();

				await jobsB.create("b", {});
				await waitFor(() => bCount === 2);
				assert.deepEqual(bCount, 2);
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
				assert.deepEqual(log, ["a"]);

				unsubAll();
				await jobs.create("b", {});
				// give it a window to (not) fire
				await waitFor(() => log.length === 2, { timeoutMs: 400 });
				assert.deepEqual(log, ["a"]);
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
				assert.deepEqual(fired, 1);
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
						updated_at = NOW() - INTERVAL '10 minutes',
						attempts = 1
					 WHERE id = $1`,
					[created.id],
				);

				const reaped = await jobs.cleanup(5);
				assert.deepEqual(reaped, 1);
				assert.deepEqual(doneFires, 1);
				assert(expiredRef.value);
				assert.deepEqual(expiredRef.value.status, JOB_STATUS.EXPIRED);
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
					started_at = NOW() - INTERVAL '2 minutes',
					updated_at = NOW() - INTERVAL '2 minutes'
				 WHERE id = $1`,
				[created.id],
			);
			const reaped = await jobs.cleanup(5);
			assert.deepEqual(reaped, 0);

			const found = await jobs.find(created.uid);
			assert.deepEqual(found.job!.status, JOB_STATUS.RUNNING);
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

			await assert.rejects(() => jobs.start(1));
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
				assert.deepEqual(jobs.__debugDump().processorsCount, 2);
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
			assert.deepEqual(jobs.__debugDump().isRunning, false);

			await jobs.start(1);
			assert.deepEqual(jobs.__debugDump().isRunning, true);
			await jobs.stop();
		},
	},

	// ---------------------------------------------------------------
	// H3 — SIGTERM listener cleanup
	{
		name: "SIGTERM listener: added on start, removed on stop",
		async fn({ db }) {
			// biome-ignore lint/suspicious/noExplicitAny: deliberately untyped test double / invalid input
			const proc = (await import("node:process")).default as any;
			const baseline = proc.listenerCount("SIGTERM");

			const jobs = track(
				new Jobs({
					db,
					logger: silentLogger(),
					gracefulSigterm: true,
					pollTimeoutMs,
					tablePrefix,
					jobHandler: () => ({}),
				}),
			);
			await jobs.resetHard();

			try {
				await jobs.start(1);
				assert.deepEqual(proc.listenerCount("SIGTERM"), baseline + 1);
			} finally {
				await jobs.stop();
			}
			assert.deepEqual(proc.listenerCount("SIGTERM"), baseline);
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
					{ backoff_strategy: "none", max_attempts: 3 },
				);
				await jobs.start(1);
				await waitFor(
					async () => {
						const { job } = await jobs.find(uid);
						return job?.status === JOB_STATUS.COMPLETED;
					},
					{ timeoutMs: 2000 },
				);

				const job = (await jobs.find(uid)).job!;
				assert.deepEqual(job.status, JOB_STATUS.COMPLETED);
				assert.deepEqual(job.attempts, 2);
				const startDelayMs =
					new Date(job.started_at).valueOf() -
					new Date(job.created_at).valueOf();
				assert(
					startDelayMs < 500,
					`started_at delay ${startDelayMs}ms too large — was started_at reset on retry?`,
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
					},
				);
				await jobs.start(1);
				await waitFor(() => abortedRef.value, { timeoutMs: 2000 });
				assert(
					abortedRef.value,
					"handler must receive AbortSignal.abort on timeout",
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
			await assert.rejects(
				// biome-ignore lint/suspicious/noExplicitAny: deliberately untyped test double / invalid input
				() => jobs.create("foo", {}, { run_at: "not-a-date" as any }),
				{ name: "TypeError", message: /Invalid 'run_at'/ },
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
				{ backoff_strategy: "exp", max_attempts: 100 },
			);

			await db.query(
				`UPDATE ${tablePrefix}__job SET status = 'running',
					attempts = 30, started_at = NOW()
				 WHERE id = $1`,
				[created.id],
			);
			const { rows: attemptRows } = await db.query(
				`INSERT INTO ${tablePrefix}__job_attempt_log (job_id, attempt_number)
				 VALUES ($1, 30) RETURNING id`,
				[created.id],
			);
			const attemptId = attemptRows[0].id;

			const { _handleJobFailure } = await import(
				"../src/steve/job/_handle-failure.ts"
			);
			const { rows: jobRows } = await db.query(
				`SELECT * FROM ${tablePrefix}__job WHERE id = $1`,
				[created.id],
			);

			// partial on purpose: _handleJobFailure only reads `db` and `tableNames`
			const context = {
				db: toPgDriver(db),
				tableNames: {
					tableJobs: `${tablePrefix}__job`,
					tableAttempts: `${tablePrefix}__job_attempt_log`,
				},
				logger: silentLogger(),
			} as JobContext;

			const failed = await _handleJobFailure(
				context,
				jobRows[0],
				attemptId,
				new Error("boom"),
			);
			assert.deepEqual(failed!.status, JOB_STATUS.PENDING);
			const deltaMs = new Date(failed!.run_at).valueOf() - Date.now();
			assert(
				deltaMs <= 60 * 60 * 1000 + 5_000,
				`backoff ${deltaMs}ms exceeds 1h cap`,
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
			assert.deepEqual(jobs.hasHandler("any-type"), false);
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
						started_at = NOW() - INTERVAL '1 minute',
						updated_at = NOW() - INTERVAL '1 minute', attempts = 1
					 WHERE id = $1`,
					[created.id],
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
