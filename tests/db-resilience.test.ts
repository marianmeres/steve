import assert from "node:assert/strict";
import type pg from "pg";
import { type Job, Jobs, type JobsOptions } from "../src/index.ts";
import { checkDbHealth } from "../src/steve/utils/db-health.ts";
import { sleep } from "../src/steve/utils/sleep.ts";
import { withDbRetry } from "../src/steve/utils/with-db-retry.ts";
import { testsRunner } from "./_tests-runner.ts";

const tablePrefix = "_db_resilience_";
const pollTimeoutMs = 100;

async function _createJobs(db: pg.Client | pg.Pool, options: Partial<JobsOptions> = {}) {
	const jobs = new Jobs({
		db,
		logger: { debug: () => {}, error: () => {}, warn: () => {}, log: () => {} },
		gracefulSigterm: false,
		pollTimeoutMs,
		tablePrefix,
		...options,
	});

	await jobs.resetHard();
	return jobs;
}

testsRunner([
	{
		name: "withDbRetry: succeeds on first attempt",
		async fn() {
			let attempts = 0;
			const result = await withDbRetry(async () => {
				attempts++;
				return "success";
			});

			assert.deepEqual(result, "success");
			assert.deepEqual(attempts, 1);
		},
	},
	{
		name: "withDbRetry: retries on retryable error",
		async fn() {
			let attempts = 0;

			const result = await withDbRetry(
				async () => {
					attempts++;
					if (attempts < 3) {
						throw Object.assign(new Error("Connection failed"), {
							code: "ECONNREFUSED",
						});
					}
					return "success";
				},
				{
					maxRetries: 5,
					initialDelayMs: 10,
					maxDelayMs: 100,
				},
			);

			assert.deepEqual(result, "success");
			assert.deepEqual(attempts, 3);
		},
	},
	{
		name: "withDbRetry: does not retry non-retryable error",
		async fn() {
			let attempts = 0;

			try {
				await withDbRetry(
					async () => {
						attempts++;
						throw new Error("Some non-retryable error");
					},
					{
						maxRetries: 5,
						initialDelayMs: 10,
					},
				);
				assert(false, "Should have thrown");
			} catch (e) {
				assert.deepEqual((e as Error).message, "Some non-retryable error");
				assert.deepEqual(attempts, 1); // no retries
			}
		},
	},
	{
		name: "withDbRetry: throws after max retries exceeded",
		async fn() {
			let attempts = 0;

			try {
				await withDbRetry(
					async () => {
						attempts++;
						throw Object.assign(new Error("Connection timeout"), {
							code: "ETIMEDOUT",
						});
					},
					{
						maxRetries: 2,
						initialDelayMs: 10,
					},
				);
				assert(false, "Should have thrown");
			} catch (e) {
				assert.deepEqual((e as Error).message, "Connection timeout");
				assert.deepEqual(attempts, 3); // initial + 2 retries
			}
		},
	},
	{
		name: "withDbRetry: retries a deadlock by default, not a unique violation",
		async fn() {
			let deadlocks = 0;
			const result = await withDbRetry(
				async () => {
					deadlocks++;
					if (deadlocks < 3) {
						throw Object.assign(new Error("deadlock detected"), {
							code: "40P01",
						});
					}
					return "success";
				},
				{ maxRetries: 5, initialDelayMs: 10 },
			);
			assert.deepEqual(result, "success");
			assert.deepEqual(deadlocks, 3);

			let duplicates = 0;
			await assert.rejects(
				withDbRetry(
					async () => {
						duplicates++;
						throw Object.assign(new Error("duplicate key value"), {
							code: "23505",
						});
					},
					{ maxRetries: 5, initialDelayMs: 10 },
				),
				{ message: "duplicate key value", code: "23505" },
			);
			assert.deepEqual(duplicates, 1); // no retries
		},
	},
	{
		name: "withDbRetry: a retryableErrors list replaces the default",
		async fn() {
			const options = {
				maxRetries: 5,
				initialDelayMs: 10,
				retryableErrors: ["XX000"],
			};

			let listed = 0;
			const result = await withDbRetry(async () => {
				listed++;
				if (listed < 3) {
					throw Object.assign(new Error("internal error"), { code: "XX000" });
				}
				return "success";
			}, options);
			assert.deepEqual(result, "success");
			assert.deepEqual(listed, 3);

			let refused = 0;
			await assert.rejects(
				withDbRetry(async () => {
					refused++;
					throw Object.assign(new Error("Connection failed"), {
						code: "ECONNREFUSED",
					});
				}, options),
				{ message: "Connection failed", code: "ECONNREFUSED" },
			);
			assert.deepEqual(refused, 1); // not on the list: no retries
		},
	},
	{
		name: "withDbRetry: an out-of-range option is a TypeError",
		async fn() {
			let calls = 0;
			await assert.rejects(
				withDbRetry(
					async () => {
						calls++;
						return "success";
					},
					{ backoffMultiplier: 0.5 },
				),
				TypeError,
			);
			assert.deepEqual(calls, 0); // refused before the first call
		},
	},
	{
		name: "checkDbHealth: returns healthy status",
		async fn({ db }) {
			const status = await checkDbHealth(db);

			assert.deepEqual(status.healthy, true);
			assert(status.latencyMs !== null);
			assert(status.latencyMs! >= 0);
			assert.deepEqual(status.error, null);
			assert(status.timestamp instanceof Date);
			assert(status.pgVersion); // should have version
		},
	},
	{
		name: "Jobs with dbRetry enabled",
		async fn({ db }) {
			const jobs = await _createJobs(db, {
				dbRetry: true,
			});

			// Just verify it starts and works normally
			await jobs.start(1);

			const job = await jobs.create("test", { foo: "bar" });
			await sleep(200);

			const found = await jobs.find(job.uid);
			assert.deepEqual(found.job!.status, "completed");

			await jobs.stop();
		},
	},
	{
		name: "Jobs with dbRetry: a refused connection is retried",
		async fn({ db }) {
			const jobs = await _createJobs(db, {
				dbRetry: { initialDelayMs: 10 },
			});

			// The pool refuses the next two connections, then works again.
			const pool = db as pg.Pool;
			const connect = pool.connect;
			const reconnect = connect.bind(pool) as () => Promise<pg.PoolClient>;
			let calls = 0;
			pool.connect = (async () => {
				calls++;
				if (calls <= 2) {
					throw Object.assign(
						new Error("connect ECONNREFUSED 127.0.0.1:5432"),
						{
							code: "ECONNREFUSED",
						},
					);
				}
				return await reconnect();
			}) as typeof pool.connect;

			let job: Job;
			try {
				job = await jobs.create("test", { foo: "bar" });
			} finally {
				pool.connect = connect;
			}
			assert.deepEqual(calls, 3);

			const found = await jobs.find(job.uid);
			assert.deepEqual(found.job?.type, "test");
			assert.deepEqual(found.job?.payload, { foo: "bar" });
		},
	},
	{
		name: "Jobs with custom dbRetry options",
		async fn({ db }) {
			const jobs = await _createJobs(db, {
				dbRetry: {
					maxRetries: 5,
					initialDelayMs: 50,
					maxDelayMs: 1000,
				},
			});

			await jobs.start(1);

			const job = await jobs.create("test", {});
			await sleep(200);

			const found = await jobs.find(job.uid);
			assert.deepEqual(found.job!.status, "completed");

			await jobs.stop();
		},
	},
	{
		name: "Jobs with dbHealthCheck enabled",
		async fn({ db }) {
			const jobs = await _createJobs(db, {
				dbHealthCheck: {
					intervalMs: 100, // check frequently for test
				},
			});

			await jobs.start(1);

			// Wait for health check to run (it runs immediately on start)
			await sleep(150);

			// Check we can get health status
			const health = jobs.getDbHealth();
			assert(health);
			assert.deepEqual(health.healthy, true);
			assert(health.latencyMs !== null);

			await jobs.stop();
		},
	},
	{
		name: "Jobs with dbHealthCheck callbacks",
		async fn({ db }) {
			const jobs = await _createJobs(db, {
				dbHealthCheck: {
					intervalMs: 50,
					onHealthy: () => {
						// Callback would be called on state changes
					},
				},
			});

			await jobs.start(1);

			// Wait long enough for at least one check
			await sleep(100);

			// Verify the health status works
			const health = jobs.getDbHealth();
			assert(health);
			assert.deepEqual(health.healthy, true);

			await jobs.stop();
		},
	},
	{
		name: "Jobs getDbHealth returns null when not enabled",
		async fn({ db }) {
			const jobs = await _createJobs(db);

			await jobs.start(1);

			const health = jobs.getDbHealth();
			assert.deepEqual(health, null);

			await jobs.stop();
		},
	},
	{
		name: "Jobs checkDbHealth works without health monitoring",
		async fn({ db }) {
			const jobs = await _createJobs(db);

			await jobs.start(1);

			// Should work even if health monitoring is not enabled
			const health = await jobs.checkDbHealth();
			assert.deepEqual(health.healthy, true);
			assert(health.latencyMs! >= 0);

			await jobs.stop();
		},
	},
	{
		name: "Health monitor stops when jobs stop",
		async fn({ db }) {
			const jobs = await _createJobs(db, {
				dbHealthCheck: {
					intervalMs: 100,
				},
			});

			await jobs.start(1);

			// Wait for at least one health check
			await sleep(150);

			// Should have health status
			const healthBefore = jobs.getDbHealth();
			assert(healthBefore);
			const timestampBefore = healthBefore.timestamp;

			await jobs.stop();

			// Wait a bit
			await sleep(250);

			// Health status should not have updated after stop
			const healthAfter = jobs.getDbHealth();
			assert(healthAfter);
			assert.deepEqual(healthAfter.timestamp, timestampBefore);
		},
	},
]);
