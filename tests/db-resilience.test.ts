import type pg from "pg";
import { Jobs } from "../src/mod.ts";
import { testsRunner } from "./_tests-runner.ts";
import { assert, assertEquals } from "@std/assert";
import { sleep } from "../src/steve/utils/sleep.ts";
import { withDbRetry } from "../src/steve/utils/with-db-retry.ts";
import { checkDbHealth } from "../src/steve/utils/db-health.ts";

const tablePrefix = "_db_resilience_";
const pollTimeoutMs = 100;

async function _createJobs(db: pg.Client | pg.Pool, options: any = {}) {
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
		async fn({ db }) {
			let attempts = 0;
			const result = await withDbRetry(async () => {
				attempts++;
				return "success";
			});

			assertEquals(result, "success");
			assertEquals(attempts, 1);
		},
	},
	{
		name: "withDbRetry: retries on retryable error",
		async fn({ db }) {
			let attempts = 0;

			const result = await withDbRetry(
				async () => {
					attempts++;
					if (attempts < 3) {
						const err: any = new Error("Connection failed");
						err.code = "ECONNREFUSED";
						throw err;
					}
					return "success";
				},
				{
					maxRetries: 5,
					initialDelayMs: 10,
					maxDelayMs: 100,
				}
			);

			assertEquals(result, "success");
			assertEquals(attempts, 3);
		},
	},
	{
		name: "withDbRetry: does not retry non-retryable error",
		async fn({ db }) {
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
					}
				);
				assert(false, "Should have thrown");
			} catch (e: any) {
				assertEquals(e.message, "Some non-retryable error");
				assertEquals(attempts, 1); // no retries
			}
		},
	},
	{
		name: "withDbRetry: throws after max retries exceeded",
		async fn({ db }) {
			let attempts = 0;

			try {
				await withDbRetry(
					async () => {
						attempts++;
						const err: any = new Error("Connection timeout");
						err.code = "ETIMEDOUT";
						throw err;
					},
					{
						maxRetries: 2,
						initialDelayMs: 10,
					}
				);
				assert(false, "Should have thrown");
			} catch (e: any) {
				assertEquals(e.message, "Connection timeout");
				assertEquals(attempts, 3); // initial + 2 retries
			}
		},
	},
	{
		name: "checkDbHealth: returns healthy status",
		async fn({ db }) {
			const status = await checkDbHealth(db);

			assertEquals(status.healthy, true);
			assert(status.latencyMs !== null);
			assert(status.latencyMs! >= 0);
			assertEquals(status.error, null);
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
			assertEquals(found.job.status, "completed");

			await jobs.stop();
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
			assertEquals(found.job.status, "completed");

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
			assertEquals(health.healthy, true);
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
			assertEquals(health.healthy, true);

			await jobs.stop();
		},
	},
	{
		name: "Jobs getDbHealth returns null when not enabled",
		async fn({ db }) {
			const jobs = await _createJobs(db);

			await jobs.start(1);

			const health = jobs.getDbHealth();
			assertEquals(health, null);

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
			assertEquals(health.healthy, true);
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
			assertEquals(healthAfter.timestamp, timestampBefore);
		},
	},
]);
