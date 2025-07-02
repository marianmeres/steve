import type { Job, JobAwareFn, JobContext, JobCreateDTO } from "../jobs.ts";

export async function _create(
	context: JobContext,
	data: JobCreateDTO,
	onDone?: JobAwareFn
): Promise<Job> {
	const { db, tableNames } = context;
	const { tableJobs } = tableNames;

	const { rows } = await db.query(
		`INSERT INTO ${tableJobs} (type, payload, max_attempts, backoff_strategy)
		VALUES ($1, $2, $3, $4)
		RETURNING *`,
		[
			data.type,
			JSON.stringify(data.payload ?? {}),
			data.max_attempts ?? null,
			data.backoff_strategy ?? null,
		]
	);

	const job = rows[0] as Job;

	if (typeof onDone === "function") {
		context.onDoneCallbacks.set(job.uid, onDone);
	}

	return job;
}
