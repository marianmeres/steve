// deno-lint-ignore-file no-explicit-any

import pg from "pg";
import {
	ATTEMPT_STATUS,
	BACKOFF_STRATEGY,
	JOB_STATUS,
	type JobHandlersMap,
	Jobs,
	type Job,
	type JobHandler,
} from "../src/mod.ts";
import { testsRunner } from "./_tests-runner.ts";

import { assert, assertEquals } from "@std/assert";
import { sleep } from "../src/steve/utils/sleep.ts";

let _logger: any = [];
const tablePrefix = "_foo_";
const pollTimeoutMs = 100; // be faster in tests

async function _createJobs(
	db: pg.Client,
	jobHandler?: JobHandler,
	jobHandlers?: JobHandlersMap
) {
	_logger = [];

	const log = (...args: any) => _logger.push(args[0]);

	const jobs = new Jobs({
		db,
		jobHandler,
		jobHandlers,
		logger: { debug: log, error: log, warn: log, log },
		// must be turned off in tests... (it leaves active process listener, which deno complains about)
		gracefulSigterm: false,
		pollTimeoutMs,
		tablePrefix,
	});

	// manually hard reset before each test
	await jobs.resetHard();

	return jobs;
}

testsRunner([
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
			let _errorCounter = 0;
			let _executionCounter = 0;

			let attemptCounter = 0;
			let doneCounter = 0;

			const jobs = await _createJobs(db, async (j: Job) => {
				_executionCounter++;
				await sleep(20);
				// simulate error on first 2 attempts
				if (j.attempts <= 2) {
					_errorCounter++;
					throw new Error("Boom");
				}
				return { hey: "ho" };
			});

			//
			jobs.onAttempt("foo", (_job: Job) => attemptCounter++);
			jobs.onDone("foo", (_job: Job) => doneCounter++);

			//
			const { uid } = await jobs.create(
				"foo",
				{ bar: "baz" },
				{ backoff_strategy: BACKOFF_STRATEGY.NONE }
			);

			await jobs.start(1);

			// sleep a while... (we need 3 process cycles)
			await sleep(500);

			assertEquals(_errorCounter, 2);
			assertEquals(_executionCounter, 3);
			assertEquals(attemptCounter, 3);
			assertEquals(doneCounter, 1);

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
			let _errorCounter = 0;
			let _executionCounter = 0;
			let doneCounter = 0;

			const jobs = await _createJobs(db, async (_j: Job) => {
				_executionCounter++;
				await sleep(20);
				_errorCounter++; // always fail
				throw new Error("Boom");
			});

			//
			jobs.onDone("foo", (_job: Job) => doneCounter++);

			//
			const { uid } = await jobs.create(
				"foo",
				{ bar: "baz" },
				{ backoff_strategy: BACKOFF_STRATEGY.NONE, max_attempts: 5 }
			);

			await jobs.start(1);

			// sleep a while... (we need 3 process cycles)
			await sleep(500);

			assertEquals(_errorCounter, 5);
			assertEquals(_executionCounter, 5);
			assertEquals(doneCounter, 1);

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
	{
		name: "custom handler by type",
		async fn({ db }) {
			const jobs = await _createJobs(db);

			const createFoo = () =>
				jobs.create(
					"foo",
					{ bar: "baz" },
					{ backoff_strategy: BACKOFF_STRATEGY.NONE, max_attempts: 1 }
				);

			let j = await createFoo();

			await jobs.start(1);

			let r = await jobs.find(j.uid);

			// no handler exists
			assertEquals(r.job.result, { noop: true });

			// register handler now
			jobs.setHandler("foo", (_j: Job) => ({ foo: "handler" }));

			j = await createFoo();

			await sleep(300);

			r = await jobs.find(j.uid);

			// now must be handler
			assertEquals(r.job.result, { foo: "handler" });

			// now unset handler
			jobs.setHandler("foo", null);

			j = await createFoo();
			await sleep(200);

			r = await jobs.find(j.uid);

			// noop again
			assertEquals(r.job.result, { noop: true });

			// teardown
			await jobs.stop();
			jobs.unsubscribeAll();
		},
		// only: true,
	},
	{
		name: "create with onDone callback",
		async fn({ db }) {
			const jobs = await _createJobs(db);
			let completedCounter = 0;
			let failedCounter = 0;

			const onDone = (j: Job) => {
				if (j.status === JOB_STATUS.FAILED) failedCounter++;
				else completedCounter++;
			};

			// create handler which will throw if payload say so...
			jobs.setHandler("foo", (j: Job) => {
				if (j.payload.doThrow) throw new Error("Boom");
			});

			const createFoo = (doThrow: boolean) =>
				jobs.create(
					"foo",
					{ doThrow },
					{ backoff_strategy: BACKOFF_STRATEGY.NONE, max_attempts: 1 },
					onDone
				);

			// create throws
			await createFoo(true); // failed
			await createFoo(true); // failed
			await createFoo(false); // completed

			// console.log(jobs.__debugDump());
			assertEquals(Object.keys(jobs.__debugDump().onDoneCallbacks).length, 3);

			await jobs.start(1);

			await sleep(100);

			// teardown
			await jobs.stop();
			jobs.unsubscribeAll();

			assertEquals(failedCounter, 2);
			assertEquals(completedCounter, 1);
		},
		// only: true,
	},
	{
		name: "schedule job run in the future",
		async fn({ db }) {
			let jobDone = false;

			const jobs = await _createJobs(db);

			let job = await jobs.create(
				"foo",
				{},
				// schedule 200 ms in the future
				{ run_at: new Date(Date.now() + 200) },
				() => (jobDone = true)
			);
			// console.log(job);

			await jobs.start(1);

			// must NOT be done yet
			assert(!jobDone);

			await sleep(100);

			// still must NOT be done yet
			assert(!jobDone);

			await sleep(250);

			// now MUST be done finally
			assert(jobDone);

			job = (await jobs.find(job.uid)).job;
			// console.log(job);

			// start and run time must differ for at least 200 ms
			assert(
				new Date(job.started_at).valueOf() -
					new Date(job.created_at).valueOf() >
					200
			);

			// teardown
			await jobs.stop();
			jobs.unsubscribeAll();
		},
		// only: true,
	},
	{
		name: "max allowed attempt duration",
		async fn({ db }) {
			const ref = { id: -1 };
			const jobs = await _createJobs(db, async (_j: Job) => {
				await sleep(500, ref); // should always time out
			});

			const job = await jobs.create(
				"foo",
				{ bar: "baz" },
				{
					backoff_strategy: BACKOFF_STRATEGY.NONE,
					max_attempts: 2,
					max_attempt_duration_ms: 150,
				}
			);

			await jobs.start(1);

			// sleep a while... (we need 3 process cycles)
			await sleep(600);

			// teardown
			await jobs.stop();
			jobs.unsubscribeAll();

			const r = await jobs.find(job.uid, true);
			// console.log(r);

			assertEquals(r.job.status, JOB_STATUS.FAILED);
			assertEquals(r.attempts?.length, 2);
			assertEquals(r.attempts?.[0].error_message, "Execution timed out");
			assertEquals(r.attempts?.[1].error_message, "Execution timed out");

			clearTimeout(ref.id);
		},
		// only: true,
	},
]);
