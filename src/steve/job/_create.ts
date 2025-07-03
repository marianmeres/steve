// deno-lint-ignore-file no-explicit-any

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
		type: true as const,
		payload: true as const,
		max_attempts: true as const,
		backoff_strategy: true as const,
		run_at: (v: any) => (v ? new Date(v).toISOString() : null),
	});

	const sql = `INSERT INTO ${tableJobs} (${keys}) VALUES (${placeholders}) RETURNING *`;
	const { rows } = await db.query(sql, values);
	const job = rows[0] as Job;

	if (typeof onDone === "function") {
		context.onDoneCallbacks.set(job.uid, onDone);
	}

	return job;
}
