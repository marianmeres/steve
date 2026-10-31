/**
 * Regression guards for the post-3.0 review fixes: reaper semantics, fenced
 * finalization, per-uid callback isolation, handler dispatch, pg.Client restriction,
 * init races and locking, purge, find() not-found, unsubscribeAll, SIGTERM lifecycle.
 */
import type pg from "pg";
import { JOB_STATUS, Jobs, type Job, type JobHandler } from "../src/index.ts";
import { testsRunner } from "./_tests-runner.ts";
import { createPgClient } from "./_pg.ts";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { sleep } from "../src/steve/utils/sleep.ts";

const tablePrefix = "_fixes_v3_";
const pollTimeoutMs = 50;

function captureLogger() {
	const lines: string[] = [];
	const push = (m: unknown) => {
		lines.push(String(m));
	};
	return { lines, logger: { debug: push, error: push, warn: push, log: push } };
}

interface CreateJobsOptions {
	jobHandler?: JobHandler;
	// biome-ignore lint/suspicious/noExplicitAny: deliberately untyped test double / invalid input
	autoCleanup?: any;
	// biome-ignore lint/suspicious/noExplicitAny: deliberately untyped test double / invalid input
	logger?: any;
	prefix?: string;
}

async function _createJobs(db: pg.Client | pg.Pool, opts: CreateJobsOptions = {}) {
	const jobs = new Jobs({
		db,
		logger: opts.logger ?? captureLogger().logger,
		gracefulSigterm: false,
		pollTimeoutMs,
		tablePrefix: opts.prefix ?? tablePrefix,
		jobHandler: opts.jobHandler,
		autoCleanup: opts.autoCleanup,
	});
	await jobs.resetHard();
	return jobs;
}

/** Await a condition with a polling budget; a single timer at a time, cleared on exit. */
async function waitFor(
	predicate: () => boolean | Promise<boolean>,
	{ timeoutMs = 2000, stepMs = 20 }: { timeoutMs?: number; stepMs?: number } = {}
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

const statusOf = (jobs: Jobs, uid: string) =>
	jobs.find(uid).then(({ job }) => job?.status);

testsRunner([
	// ---------------------------------------------------------------
	// reaper measures the CURRENT attempt
	{
		name: "cleanup: measures the current attempt (updated_at), not the first attempt (started_at)",
		async fn({ db }) {
			const jobs = await _createJobs(db);
			const created = await jobs.create("x", {});

			// What a job on its 2nd attempt looks like when the 1st attempt was long ago
			// but THIS attempt was claimed just now (the claim sets updated_at = NOW()).
			await db.query(
				`UPDATE ${tablePrefix}__job SET status = 'running', attempts = 2,
					started_at = NOW() - INTERVAL '10 minutes', updated_at = NOW()
				 WHERE id = $1`,
				[created.id]
			);
			assert.deepEqual(await jobs.cleanup(5), 0, "a fresh attempt must NOT be reaped");
			assert.deepEqual(await statusOf(jobs, created.uid), JOB_STATUS.RUNNING);

			// ...and once the CURRENT attempt is genuinely stale, it is reaped.
			await db.query(
				`UPDATE ${tablePrefix}__job SET updated_at = NOW() - INTERVAL '10 minutes'
				 WHERE id = $1`,
				[created.id]
			);
			assert.deepEqual(await jobs.cleanup(5), 1);
			assert.deepEqual(await statusOf(jobs, created.uid), JOB_STATUS.EXPIRED);
		},
	},

	// ---------------------------------------------------------------
	// fenced finalization: terminal state is never overwritten
	{
		name: "finalization: a handler that outlives the reaper does not overwrite the terminal state",
		async fn({ db }) {
			const ref = { id: -1 };
			const { lines, logger } = captureLogger();
			const jobs = await _createJobs(db, {
				logger,
				jobHandler: async () => {
					await sleep(400, ref);
					return { late: true };
				},
			});
			const done: Job[] = [];
			jobs.onDone("x", (j: Job) => {
				done.push(j);
			});

			try {
				const created = await jobs.create("x", {}, { max_attempts: 1 });
				await jobs.start(1);
				await waitFor(async () => (await statusOf(jobs, created.uid)) === JOB_STATUS.RUNNING);

				// reap it while the handler is still running (threshold 0 => claimed before now)
				assert.deepEqual(await jobs.cleanup(0), 1);
				assert.deepEqual(done.length, 1);
				assert.deepEqual(done[0]!.status, JOB_STATUS.EXPIRED);

				// let the handler finish and finalization run
				await waitFor(async () => {
					const { attempts } = await jobs.find(created.uid, true);
					return attempts?.[0]?.status === "success";
				});

				const { job, attempts } = await jobs.find(created.uid, true);
				assert.deepEqual(job!.status, JOB_STATUS.EXPIRED, "expired must stay expired");
				assert.deepEqual(job!.result, {}, "late result must not be stored on the row");
				assert.deepEqual(attempts![0]!.status, "success", "attempt log stays truthful");
				assert.deepEqual(done.length, 1, "onDone must fire exactly once");
				assert(
					lines.some((l) => /already finalized elsewhere/.test(l)),
					"the late finalization must be logged"
				);
			} finally {
				await jobs.stop();
				jobs.unsubscribeAll();
				clearTimeout(ref.id);
			}
		},
	},

	// ---------------------------------------------------------------
	// per-uid callbacks are isolated from the job lifecycle
	{
		name: "per-uid onDone: a throwing callback does not fail or re-run a completed job",
		async fn({ db }) {
			let executions = 0;
			const ref = { id: -1 };
			const { lines, logger } = captureLogger();
			const jobs = await _createJobs(db, {
				logger,
				jobHandler: () => {
					executions++;
					return { ok: true };
				},
			});

			try {
				const created = await jobs.create(
					"x",
					{},
					{ backoff_strategy: "none", max_attempts: 3 },
					() => {
						throw new Error("consumer bug");
					}
				);
				await jobs.start(1);
				await waitFor(async () => (await statusOf(jobs, created.uid)) === JOB_STATUS.COMPLETED);
				// give a (wrong) retry every chance to happen
				await sleep(300, ref);

				const { job, attempts } = await jobs.find(created.uid, true);
				assert.deepEqual(job!.status, JOB_STATUS.COMPLETED);
				assert.deepEqual(executions, 1, "handler must run exactly once");
				assert.deepEqual(attempts!.length, 1);
				assert.deepEqual(attempts![0]!.status, "success");
				assert(lines.some((l) => /onDone callback/.test(l) && /consumer bug/.test(l)));
			} finally {
				await jobs.stop();
				jobs.unsubscribeAll();
				clearTimeout(ref.id);
			}
		},
	},
	{
		name: "per-uid onDone: an async rejecting callback is logged, not an unhandled rejection",
		async fn({ db }) {
			let unhandled = 0;
			const onUnhandled = () => {
				unhandled++;
			};
			process.on("unhandledRejection", onUnhandled);
			const ref = { id: -1 };
			const { lines, logger } = captureLogger();
			const jobs = await _createJobs(db, { logger, jobHandler: () => ({ ok: true }) });

			try {
				const created = await jobs.create("x", {}, { max_attempts: 1 }, () =>
					Promise.reject(new Error("async consumer bug"))
				);
				await jobs.start(1);
				await waitFor(async () => (await statusOf(jobs, created.uid)) === JOB_STATUS.COMPLETED);
				await sleep(100, ref);

				assert.deepEqual(unhandled, 0);
				assert(lines.some((l) => /onDone callback/.test(l) && /async consumer bug/.test(l)));
			} finally {
				await jobs.stop();
				jobs.unsubscribeAll();
				clearTimeout(ref.id);
				process.off("unhandledRejection", onUnhandled);
			}
		},
	},
	{
		name: "per-uid onAttemptFor: a throwing callback does not prevent execution",
		async fn({ db }) {
			let executions = 0;
			const jobs = await _createJobs(db, {
				jobHandler: () => {
					executions++;
					return { ok: true };
				},
			});
			try {
				const created = await jobs.create("x", {}, { max_attempts: 1 });
				jobs.onAttemptFor(created.uid, () => {
					throw new Error("attempt cb bug");
				});
				await jobs.start(1);
				await waitFor(async () => (await statusOf(jobs, created.uid)) === JOB_STATUS.COMPLETED);
				const { job, attempts } = await jobs.find(created.uid, true);
				assert.deepEqual(job!.status, JOB_STATUS.COMPLETED);
				assert.deepEqual(executions, 1);
				assert.deepEqual(attempts![0]!.status, "success");
			} finally {
				await jobs.stop();
				jobs.unsubscribeAll();
			}
		},
	},

	// ---------------------------------------------------------------
	// handler dispatch cannot be hijacked by prototype member names
	{
		name: "handlers: job types named after Object.prototype members cannot hijack dispatch",
		async fn({ db }) {
			const jobs = await _createJobs(db, { jobHandler: () => ({ global: true }) });
			try {
				await jobs.start(1);
				for (const type of ["constructor", "toString", "hasOwnProperty", "__proto__"]) {
					const j = await jobs.create(type, {}, { max_attempts: 1 });
					await waitFor(async () => {
						const s = await statusOf(jobs, j.uid);
						return s === JOB_STATUS.COMPLETED || s === JOB_STATUS.FAILED;
					});
					const { job } = await jobs.find(j.uid);
					assert.deepEqual(job!.status, JOB_STATUS.COMPLETED, `type "${type}"`);
					assert.deepEqual(job!.result, { global: true }, `type "${type}"`);
				}

				jobs.resetHandlers();
				assert.deepEqual(jobs.hasHandler("constructor"), false);
				jobs.setHandler("__proto__", () => ({}));
				assert.deepEqual(jobs.hasHandler("__proto__"), true);
				assert.deepEqual(jobs.hasHandler("x"), false);
			} finally {
				await jobs.stop();
			}
		},
	},

	// ---------------------------------------------------------------
	// pg.Client: one processor only
	{
		name: "start(): a pg.Client is limited to a single processor",
		async fn(_ctx) {
			const client = createPgClient();
			await client.connect();
			const jobs = new Jobs({
				db: client,
				logger: captureLogger().logger,
				gracefulSigterm: false,
				pollTimeoutMs,
				tablePrefix: "_fixes_v3_client_",
				jobHandler: () => ({ ok: true }),
			});
			try {
				await jobs.resetHard();
				await assert.rejects(() => jobs.start(2), { message: /single processor/ });

				await jobs.start(1);
				const j = await jobs.create("x", {}, { max_attempts: 1 });
				await waitFor(async () => (await statusOf(jobs, j.uid)) === JOB_STATUS.COMPLETED);
				assert.deepEqual(await statusOf(jobs, j.uid), JOB_STATUS.COMPLETED);
				await jobs.stop();
				await jobs.uninstall();
			} finally {
				await client.end();
			}
		},
		raw: true,
	},

	// ---------------------------------------------------------------
	// schema initialization
	{
		name: "init: concurrent first calls share one initialization; resetHard() always runs",
		async fn({ db }) {
			const prefix = "_fixes_v3_init_";
			const jobs = new Jobs({
				db,
				logger: captureLogger().logger,
				gracefulSigterm: false,
				pollTimeoutMs,
				tablePrefix: prefix,
				jobHandler: () => ({}),
			});
			try {
				await jobs.uninstall(); // fresh: tables absent
				await Promise.all([jobs.start(1), jobs.create("x", {}), jobs.fetchAll()]);
				await jobs.stop();

				// resetHard on an already-initialized instance must really reset
				await jobs.create("y", {});
				assert((await jobs.fetchAll()).length >= 1);
				await jobs.resetHard();
				assert.deepEqual((await jobs.fetchAll()).length, 0);
			} finally {
				await jobs.uninstall();
			}
		},
	},
	{
		name: "init: on an already-migrated table takes no exclusive lock (does not queue behind an open reader)",
		async fn({ db }) {
			await _createJobs(db); // tables exist and are up to date
			const reader = await (db as pg.Pool).connect();
			try {
				await reader.query("BEGIN");
				await reader.query(`SELECT count(*) FROM ${tablePrefix}__job`); // holds ACCESS SHARE

				// a separate instance => its own first initialization against the live table
				const fresh = new Jobs({
					db,
					logger: captureLogger().logger,
					gracefulSigterm: false,
					pollTimeoutMs,
					tablePrefix,
				});
				const ref = { id: -1 };
				const init = fresh.fetchAll().then(() => "ok");
				const outcome = await Promise.race([init, sleep(2500, ref).then(() => "blocked")]);
				clearTimeout(ref.id);
				await reader.query("ROLLBACK");
				await init; // settle either way
				assert.deepEqual(
					outcome,
					"ok",
					"schema init must not take an ACCESS EXCLUSIVE lock when nothing needs to change"
				);
			} finally {
				reader.release();
			}
		},
	},

	// ---------------------------------------------------------------
	// purge
	{
		name: "purge: deletes old terminal jobs (and their attempt logs), leaves the rest",
		async fn({ db }) {
			const jobs = await _createJobs(db, { jobHandler: () => ({ ok: true }) });
			const a = await jobs.create("x", {}, { max_attempts: 1 });
			const b = await jobs.create("x", {}, { max_attempts: 1 });
			const c = await jobs.create("x", {}, { max_attempts: 1 });
			try {
				await jobs.start(1);
				await waitFor(async () => {
					const all = await jobs.fetchAll(JOB_STATUS.COMPLETED);
					return all.length === 3;
				});
			} finally {
				await jobs.stop();
			}

			// age two of them past a 7-day retention
			await db.query(
				`UPDATE ${tablePrefix}__job SET completed_at = NOW() - INTERVAL '10 days'
				 WHERE id IN ($1, $2)`,
				[a.id, b.id]
			);

			assert.deepEqual(await jobs.purge(7 * 24 * 60), 2);
			assert.deepEqual((await jobs.find(a.uid)).job, undefined);
			assert.deepEqual((await jobs.find(b.uid)).job, undefined);
			assert.deepEqual(await statusOf(jobs, c.uid), JOB_STATUS.COMPLETED);

			const { rows } = await db.query(
				`SELECT count(*)::int AS n FROM ${tablePrefix}__job_attempt_log`
			);
			assert.deepEqual(rows[0].n, 1, "attempt logs must cascade");

			// nothing left within retention
			assert.deepEqual(await jobs.purge(7 * 24 * 60), 0);

			// non-terminal statuses can never be purged
			await assert.rejects(
				// biome-ignore lint/suspicious/noExplicitAny: deliberately untyped test double / invalid input
				() => jobs.purge(0, { statuses: ["pending"] as any }),
				TypeError
			);
			await assert.rejects(
				// biome-ignore lint/suspicious/noExplicitAny: deliberately untyped test double / invalid input
				() => jobs.purge(0, { statuses: ["completed", "running"] as any }),
				TypeError
			);
		},
	},

	// ---------------------------------------------------------------
	// find(): not-found semantics
	{
		name: "find(): a malformed uid is a plain not-found, not a Postgres error",
		async fn({ db }) {
			const jobs = await _createJobs(db);
			const r = await jobs.find("not-a-uuid", true);
			assert.deepEqual(r.job, undefined);
			assert.deepEqual(r.attempts, null);
			assert.deepEqual((await jobs.find("", false, { tenant_id: "acme" })).job, undefined);
		},
	},

	// ---------------------------------------------------------------
	// unsubscribeAll
	{
		name: "unsubscribeAll(): also drops per-uid callbacks",
		async fn({ db }) {
			const jobs = await _createJobs(db);
			const j = await jobs.create("x", {}, {}, () => {});
			jobs.onDoneFor(j.uid, () => {});
			jobs.onAttemptFor(j.uid, () => {});
			assert.deepEqual(Object.keys(jobs.__debugDump().onDoneCallbacks).length, 1);
			assert.deepEqual(Object.keys(jobs.__debugDump().onAttemptCallbacks).length, 1);
			jobs.unsubscribeAll();
			assert.deepEqual(Object.keys(jobs.__debugDump().onDoneCallbacks).length, 0);
			assert.deepEqual(Object.keys(jobs.__debugDump().onAttemptCallbacks).length, 0);
		},
	},

	// ---------------------------------------------------------------
	// SIGTERM lifecycle (subprocess: the signal must end the process, not just stop jobs)
	{
		name: "SIGTERM: default handler stops processing, then lets the process terminate",
		async fn({ db }) {
			// Under `pnpm run test:deno` (the gate before a JSR publish) the child runs on
			// Deno too, which needs `run -A`; Node runs the .ts directly.
			const childPath = join("tests", "_sigterm-child.ts");
			const args = "Deno" in globalThis ? ["run", "-A", childPath] : [childPath];
			const child = spawn(process.execPath, args, {
				cwd: join(import.meta.dirname, ".."),
				stdio: ["ignore", "pipe", "pipe"],
			});

			let out = "";
			child.stdout.setEncoding("utf8");
			child.stdout.on("data", (chunk: string) => {
				out += chunk;
			});
			child.stderr.resume();
			// "close" == the child is gone AND its stdout is drained
			const exited = new Promise<{ code: number | null; signal: string | null }>(
				(resolve) => child.once("close", (code, signal) => resolve({ code, signal }))
			);

			try {
				await waitFor(() => out.includes("STARTED"), { timeoutMs: 15_000 });
				assert(out.includes("STARTED"), `child did not start:\n${out}`);

				child.kill("SIGTERM");

				const ref = { id: -1 };
				const status = await Promise.race([
					exited,
					sleep(15_000, ref).then(() => null),
				]);
				clearTimeout(ref.id);
				if (!status) {
					child.kill("SIGKILL");
					await exited;
					throw new Error(`child did not terminate after SIGTERM:\n${out}`);
				}
				assert(status.code !== 0);
				assert(
					status.signal === "SIGTERM" || status.code === 143,
					`expected SIGTERM termination, got ${JSON.stringify(status)}`
				);
				assert(/Job processor .* stopped/.test(out), `must stop gracefully first:\n${out}`);
				assert(/Re-raising SIGTERM/.test(out), `must re-raise after stop():\n${out}`);
			} finally {
				if (child.exitCode === null && child.signalCode === null) {
					child.kill("SIGKILL");
					await exited;
				}
				await db.query(`DROP TABLE IF EXISTS _sigterm_child___job_attempt_log;`);
				await db.query(`DROP TABLE IF EXISTS _sigterm_child___job;`);
			}
		},
	},
]);
