import assert from "node:assert/strict";
import type pg from "pg";
import { JOB_STATUS, type Job, Jobs } from "../src/index.ts";
import { sleep } from "../src/steve/utils/sleep.ts";
import { testsRunner } from "./_tests-runner.ts";

const silent = { debug() {}, error() {}, warn() {}, log() {} };
const tablePrefix = "_tenant_";
const pollTimeoutMs = 100;

async function _createJobs(db: pg.Client | pg.Pool, jobHandler?: (job: Job) => unknown) {
	const jobs = new Jobs({
		db,
		jobHandler,
		logger: silent,
		gracefulSigterm: false,
		pollTimeoutMs,
		tablePrefix,
	});
	await jobs.resetHard();
	return jobs;
}

testsRunner([
	{
		name: "tenant_id defaults to null and is preserved when tagged",
		async fn({ db }) {
			const jobs = await _createJobs(db);

			const global = await jobs.create("g", { a: 1 });
			const tagged = await jobs.create("t", { a: 1 }, { tenant_id: "acme" });

			// returned shape carries the column
			assert.deepEqual(global.tenant_id, null);
			assert.deepEqual(tagged.tenant_id, "acme");

			// round-trips via find
			assert.deepEqual((await jobs.find(global.uid)).job!.tenant_id, null);
			assert.deepEqual((await jobs.find(tagged.uid)).job!.tenant_id, "acme");

			// empty string / null are treated as "global" (NULL)
			const e1 = await jobs.create("e", {}, { tenant_id: "" });
			const e2 = await jobs.create("e", {}, { tenant_id: null });
			assert.deepEqual(e1.tenant_id, null);
			assert.deepEqual(e2.tenant_id, null);
		},
	},
	{
		name: "fetchAll filters by tenant_id (single, array, and unfiltered)",
		async fn({ db }) {
			const jobs = await _createJobs(db);

			await jobs.create("x", {}, { tenant_id: "acme" });
			await jobs.create("x", {}, { tenant_id: "acme" });
			await jobs.create("x", {}, { tenant_id: "globex" });
			await jobs.create("x", {}); // global / un-scoped

			const acme = await jobs.fetchAll(null, { tenant_id: "acme" });
			assert.deepEqual(acme.length, 2);
			assert(acme.every((j) => j.tenant_id === "acme"));

			const both = await jobs.fetchAll(null, {
				tenant_id: ["acme", "globex"],
			});
			assert.deepEqual(both.length, 3);
			assert(both.every((j) => j.tenant_id !== null));

			// unfiltered returns everything incl. the global job
			const all = await jobs.fetchAll();
			assert.deepEqual(all.length, 4);
			assert(all.some((j) => j.tenant_id === null));

			// tenant + status filter compose
			const acmePending = await jobs.fetchAll(JOB_STATUS.PENDING, {
				tenant_id: "acme",
			});
			assert.deepEqual(acmePending.length, 2);
		},
	},
	{
		name: "find tenant guard reports a mismatch as not-found",
		async fn({ db }) {
			const jobs = await _createJobs(db);
			const job = await jobs.create("x", {}, { tenant_id: "acme" });

			// correct tenant => found
			assert((await jobs.find(job.uid, false, { tenant_id: "acme" })).job);
			// wrong tenant => not found (defense-in-depth; uid is globally unique)
			assert.deepEqual(
				(await jobs.find(job.uid, false, { tenant_id: "globex" })).job,
				undefined,
			);
			// no guard => found regardless
			assert((await jobs.find(job.uid)).job);
		},
	},
	{
		name: "a tenant-blind worker still drains tenant-tagged jobs",
		async fn({ db }) {
			const seen: Job[] = [];
			const jobs = await _createJobs(db, (job: Job) => {
				seen.push(job);
				return { ok: true };
			});

			const job = await jobs.create("x", {}, { tenant_id: "acme" });
			await jobs.start(1);
			// give the worker time to claim + complete
			for (let i = 0; i < 20 && seen.length === 0; i++) await sleep(50);
			await jobs.stop();

			const done = (await jobs.find(job.uid)).job!;
			assert.deepEqual(done.status, JOB_STATUS.COMPLETED);
			// the handler observed the tenant_id, and it survives completion
			assert.deepEqual(seen[0]?.tenant_id, "acme");
			assert.deepEqual(done.tenant_id, "acme");
		},
	},
	{
		name: "healthPreview can be scoped to a tenant",
		async fn({ db }) {
			const jobs = await _createJobs(db);
			await jobs.create("x", {}, { tenant_id: "acme" });
			await jobs.create("x", {}, { tenant_id: "acme" });
			await jobs.create("x", {}, { tenant_id: "globex" });
			await jobs.create("x", {}); // global

			const acme = await jobs.healthPreview(60, { tenant_id: "acme" });
			const pending = acme.find((r) => r.status === JOB_STATUS.PENDING);
			assert.deepEqual(Number(pending?.count), 2);

			// unscoped sees all four
			const all = await jobs.healthPreview(60);
			const allPending = all.find((r) => r.status === JOB_STATUS.PENDING);
			assert.deepEqual(Number(allPending?.count), 4);
		},
	},
	{
		name: "cleanup can be scoped to a tenant (others left untouched)",
		async fn({ db }) {
			const jobs = await _createJobs(db);
			const a = await jobs.create("x", {}, { tenant_id: "acme" });
			const g = await jobs.create("x", {}, { tenant_id: "globex" });

			// force both into a long-stuck running state
			const tableJobs = `${tablePrefix}__job`;
			await db.query(
				`UPDATE ${tableJobs}
				 SET status = '${JOB_STATUS.RUNNING}',
				     started_at = NOW() - INTERVAL '60 minutes',
				     updated_at = NOW() - INTERVAL '60 minutes'
				 WHERE uid IN ($1, $2)`,
				[a.uid, g.uid],
			);

			const reaped = await jobs.cleanup(5, { tenant_id: "acme" });
			assert.deepEqual(reaped, 1);

			assert.deepEqual((await jobs.find(a.uid)).job!.status, JOB_STATUS.EXPIRED);
			// globex's stuck job is NOT reaped by the acme-scoped cleanup
			assert.deepEqual((await jobs.find(g.uid)).job!.status, JOB_STATUS.RUNNING);
		},
	},
	{
		name: "self-heal: tenant_id is added to an already-deployed (pre-tenant) table",
		async fn({ db }) {
			const prefix = "_tenant_heal_";
			const tableJobs = `${prefix}__job`;
			const tableAttempts = `${prefix}__job_attempt_log`;

			// clean slate, then create the OLD (pre-tenant_id) __job shape by hand
			await db.query(`DROP TABLE IF EXISTS ${tableAttempts};`);
			await db.query(`DROP TABLE IF EXISTS ${tableJobs};`);
			await db.query(`
				CREATE TABLE ${tableJobs} (
					id SERIAL PRIMARY KEY,
					uid UUID NOT NULL DEFAULT gen_random_uuid(),
					type VARCHAR(255) NOT NULL,
					payload JSONB NOT NULL DEFAULT '{}',
					status VARCHAR(20) NOT NULL DEFAULT 'pending',
					result JSONB NOT NULL DEFAULT '{}',
					attempts INTEGER DEFAULT 0,
					max_attempts INTEGER DEFAULT 3,
					max_attempt_duration_ms INTEGER DEFAULT 0,
					created_at TIMESTAMPTZ DEFAULT NOW(),
					updated_at TIMESTAMPTZ DEFAULT NOW(),
					run_at TIMESTAMPTZ DEFAULT NOW(),
					started_at TIMESTAMPTZ,
					completed_at TIMESTAMPTZ,
					backoff_strategy VARCHAR(20) NOT NULL DEFAULT 'exp'
				);
			`);
			const { rows: legacyRows } = await db.query(
				`INSERT INTO ${tableJobs} (type) VALUES ('legacy') RETURNING *`,
			);
			const legacy = legacyRows[0];
			assert(!("tenant_id" in legacy), "old shape must NOT have tenant_id");

			// constructing + touching the queue triggers a non-hard initialize,
			// which self-heals the existing table via ADD COLUMN IF NOT EXISTS
			const jobs = new Jobs({
				db,
				logger: silent,
				gracefulSigterm: false,
				tablePrefix: prefix,
			});
			await jobs.fetchAll(); // fires #initializeOnce(false)

			// the column now exists and the legacy row reads back NULL (truthful)
			const { rows } = await db.query(
				`SELECT tenant_id FROM ${tableJobs} WHERE id = $1`,
				[legacy.id],
			);
			assert.deepEqual(rows[0].tenant_id, null);

			// and tenant-tagged creation works against the healed table
			const tagged = await jobs.create("x", {}, { tenant_id: "acme" });
			assert.deepEqual(tagged.tenant_id, "acme");

			await jobs.uninstall();
		},
	},
]);
