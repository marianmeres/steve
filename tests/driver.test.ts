import assert from "node:assert/strict";
import { createPgDriver } from "@marianmeres/sqlkit/pg";
import { openSqlite } from "@marianmeres/sqlkit/sqlite";
import { checkDbHealth, JOB_STATUS, type Job, Jobs } from "../src/index.ts";
import { isPool } from "../src/steve/utils/driver.ts";
import { testsRunner } from "./_tests-runner.ts";

const pollTimeoutMs = 100;

function silentLogger() {
	return { debug: () => {}, error: () => {}, warn: () => {}, log: () => {} };
}

testsRunner([
	{
		name: "driver: a sqlkit Driver built by the host runs a job to completed",
		async fn({ db }) {
			assert(isPool(db));
			// The host's driver: steve uses it as it is and never closes it (the pool is
			// ended by the runner, and closing the driver would end it twice).
			const driver = createPgDriver(db);
			const jobs = new Jobs({
				db: driver,
				logger: silentLogger(),
				gracefulSigterm: false,
				pollTimeoutMs,
				tablePrefix: "_driver_",
				jobHandler: () => ({ ok: true }),
			});
			try {
				await jobs.resetHard();
				const done = new Promise<Job>((resolve) => {
					jobs.onDone("x", resolve);
				});
				await jobs.start(2);
				const created = await jobs.create("x", {}, { max_attempts: 1 });
				const finalized = await done;
				assert.deepEqual(finalized.uid, created.uid);
				assert.deepEqual(finalized.status, JOB_STATUS.COMPLETED);

				const { job, attempts } = await jobs.find(created.uid, true);
				assert.deepEqual(job?.status, JOB_STATUS.COMPLETED);
				assert.deepEqual(attempts?.length, 1);
				assert.deepEqual(attempts?.[0]?.status, "success");
			} finally {
				await jobs.stop();
				await jobs.uninstall();
			}
		},
	},
	{
		name: "driver: a driver of another dialect is refused at construction",
		async fn() {
			const sqlite = openSqlite();
			try {
				assert.throws(
					() =>
						new Jobs({
							db: sqlite,
							logger: silentLogger(),
							gracefulSigterm: false,
						}),
					(e: unknown) =>
						e instanceof TypeError && /PostgreSQL/.test(e.message),
				);
			} finally {
				await sqlite.close();
			}
		},
		raw: true,
	},
	{
		name: "driver: one driver per pool, however many callers share it",
		async fn({ db }) {
			assert(isPool(db));
			assert.deepEqual(db.listenerCount("error"), 0);

			const options = {
				db,
				logger: silentLogger(),
				gracefulSigterm: false,
				tablePrefix: "_driver_",
			};
			new Jobs(options);
			new Jobs(options);
			for (let i = 0; i < 20; i++) {
				const status = await checkDbHealth(db);
				assert(status.healthy, status.error ?? "unhealthy");
			}

			assert.deepEqual(db.listenerCount("error"), 1);
		},
	},
]);
