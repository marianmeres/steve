import type { Job, JobAwareFn, JobContext, JobCreateDTO } from "../jobs.ts";
import { dataToSqlParams } from "@marianmeres/data-to-sql-params";

export async function _create(
	context: JobContext,
	data: JobCreateDTO,
	onDone?: JobAwareFn
): Promise<Job> {
	const { db, tableNames } = context;
	const { tableJobs } = tableNames;

	const { keys, values, placeholders } = dataToSqlParams(data, {
		type: true,
		payload: true,
		max_attempts: true,
		backoff_strategy: true,
		max_attempt_duration_ms: true,
		run_at: (v: any) => (v ? new Date(v).toISOString() : null),
	});

	const sql = `INSERT INTO ${tableJobs} (${keys}) VALUES (${placeholders}) RETURNING *`;
	const { rows } = await db.query(sql, values);
	const job = rows[0] as Job;

	if (typeof onDone === "function") {
		if (!context.onDoneCallbacks.has(job.uid)) {
			context.onDoneCallbacks.set(job.uid, new Set());
		}
		context.onDoneCallbacks.get(job.uid)?.add(onDone);
	}

	return job;
}
