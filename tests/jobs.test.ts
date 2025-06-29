// deno-lint-ignore-file no-explicit-any

import pg from "pg";
import {
	__jobsSchema,
	ATTEMPT_STATUS,
	BACKOFF_STRATEGY,
	createJobs,
	JOB_STATUS,
	type Job,
	type JobHandler,
} from "../src/mod.ts";
import { testsRunner } from "./_tests-runner.ts";

import { assert, assertEquals, assertRejects } from "@std/assert";
import { sleep } from "../src/steve/utils/sleep.ts";

let _logger: any = [];
const tablePrefix = "_foo_";
const pollTimeoutMs = 100; // be faster in tests

async function _createJobs(db: pg.Client, jobHandler: JobHandler) {
	// so we're recreating the schema on each test
	await db.query(__jobsSchema(tablePrefix).drop);
	_logger = [];

	const jobs = await createJobs({
		db,
		jobHandler,
		logger: (...args: any) => _logger.push(args[0]),
		// must be turned off in tests... (it leaves active process listener, which deno complains about)
		gracefulSigterm: false,
		pollTimeoutMs,
		tablePrefix,
	});

	return jobs;
}

testsRunner([
	{
		name: "sanity check",
		async fn({ db }) {
			const jobs = await _createJobs(db, (job: Job) => {
				console.log(job);
			});

			// table must not exist yet
			assertRejects(() => db.query("select * from _foo_job"));
			await jobs.start(1);

			// now it must exist
			const { rows } = await db.query("select * from _foo_job");
			assertEquals(rows, []);

			await jobs.stop();

			// some system initialization messages must have been logged
			assert(_logger.length);
		},
	},
	{
		name: "happy flow",
		async fn({ db }) {
			const log: any[] = [];
			const jobs = await _createJobs(db, async (job: Job) => {
				await sleep(20);
				log.push(job);
				return { hey: "ho" };
			});

			let job = await jobs.create("foo", { bar: "baz" }, { max_attempts: 5 });
			const jobFound = (await jobs.find(job.uid)).job;

			// just some sanity checks if the row was properly created
			assertEquals(job, jobFound);
			assertEquals(job.type, "foo");
			assertEquals(job.status, JOB_STATUS.PENDING);
			assertEquals(job.payload, { bar: "baz" });
			assertEquals(job.attempts, 0);
			assertEquals(job.max_attempts, 5);

			// must exists
			assert(job.created_at);
			assert(job.updated_at);
			assert(job.run_at);
			// must not
			assert(!job.started_at);
			assert(!job.completed_at);

			// start processing... the first job will be claimed and processed right now
			// because polling happens after the claim...
			await jobs.start(1);

			//
			job = (await jobs.find(job.uid)).job;
			// console.log(job);

			// out job handler sleeps a bit, so we know, that it must be
			// running first attempt, and not completed yet
			assertEquals(job.status, JOB_STATUS.RUNNING);
			assertEquals(job.attempts, 1);
			assert(job.started_at);
			assert(!job.completed_at);

			// make sure to sleep long enough for the job to complete (the job takes 20ms)
			await sleep(100);

			//
			const r = await jobs.find(job.uid, true);
			// console.log(r);
			job = r.job;
			const attempts = r.attempts;

			//
			assertEquals(job.status, JOB_STATUS.COMPLETED);
			assertEquals(job.attempts, 1);
			assertEquals(job.result, { hey: "ho" });
			assert(job.started_at);
			assert(job.completed_at);
			assert(new Date(job.completed_at) > new Date(job.started_at));

			//
			assertEquals(attempts?.length, 1);
			assertEquals(attempts![0].status, ATTEMPT_STATUS.SUCCESS);
			assert(
				new Date(attempts![0].completed_at) > new Date(attempts![0].started_at)
			);

			// as a sideeffect our job was logged during the handling (was in running status)...
			assertEquals(log.length, 1);
			assertEquals(log[0].status, JOB_STATUS.RUNNING);

			//
			await jobs.stop();
		},
		// only: true,
	},
	{
		name: "successful retry",
		async fn({ db }) {
			let successCounter = 0;
			let errorCounter = 0;
			let failureCounter = 0;
			let executionCounter = 0;

			const jobs = await _createJobs(db, async (j: Job) => {
				executionCounter++;
				await sleep(20);
				// simulate error on first 2 attempts
				if (j.attempts <= 2) {
					errorCounter++;
					throw new Error("Boom");
				}
				return { hey: "ho" };
			});

			//
			jobs.onSuccess("foo", (_job: Job) => successCounter++);
			jobs.onFailure("foo", (_job: Job) => failureCounter++);

			//
			const { uid } = await jobs.create(
				"foo",
				{ bar: "baz" },
				{ backoff_strategy: BACKOFF_STRATEGY.NONE }
			);

			await jobs.start(1);

			// sleep a while... (we need 3 process cycles)
			await sleep(500);

			assertEquals(successCounter, 1);
			assertEquals(errorCounter, 2);
			assertEquals(executionCounter, 3);
			assertEquals(failureCounter, 0);

			// we must see 3 logged executions system messages
			let _loggerExecCounter = 0;
			_logger.forEach((msg: string) => {
				if (/executing job 1/i.test(msg)) _loggerExecCounter++;
			});
			assertEquals(_loggerExecCounter, 3);

			// we must see 3 logged attempts (first 2 are errors)
			const { attempts } = await jobs.find(uid, true);
			assertEquals(attempts?.length, 3);
			assertEquals(attempts![0].status, ATTEMPT_STATUS.ERROR);
			assertEquals(attempts![1].status, ATTEMPT_STATUS.ERROR);
			assertEquals(attempts![2].status, ATTEMPT_STATUS.SUCCESS);
			[0, 1].forEach((i) => {
				assertEquals(attempts![i].error_message, "Boom");
				assert(attempts![i].error_details!.stack);
			});

			// teardown
			await jobs.stop();
			jobs.unsubscribeAll();

			const all = await jobs.fetchAll();
			assertEquals(all.length, 1);
			assertEquals(all[0].status, JOB_STATUS.COMPLETED);
		},
		// only: true,
	},
	{
		name: "failed attempt",
		async fn({ db }) {
			let successCounter = 0;
			let errorCounter = 0;
			let failureCounter = 0;
			let executionCounter = 0;

			const jobs = await _createJobs(db, async (_j: Job) => {
				executionCounter++;
				await sleep(20);
				errorCounter++; // always fail
				throw new Error("Boom");
			});

			//
			jobs.onSuccess("foo", (_job: Job) => successCounter++);
			jobs.onFailure("foo", (_job: Job) => failureCounter++);

			//
			const { uid } = await jobs.create(
				"foo",
				{ bar: "baz" },
				{ backoff_strategy: BACKOFF_STRATEGY.NONE, max_attempts: 5 }
			);

			await jobs.start(1);

			// sleep a while... (we need 3 process cycles)
			await sleep(500);

			assertEquals(successCounter, 0);
			assertEquals(errorCounter, 5);
			assertEquals(executionCounter, 5);
			assertEquals(failureCounter, 1);

			const { attempts } = await jobs.find(uid, true);
			assertEquals(attempts!.length, 5);

			// teardown
			await jobs.stop();
			jobs.unsubscribeAll();

			const all = await jobs.fetchAll();
			assertEquals(all.length, 1);
			assertEquals(all[0].status, JOB_STATUS.FAILED);

			assertEquals(await jobs.fetchAll(JOB_STATUS.PENDING), []);
		},
		// only: true,
	},
]);
