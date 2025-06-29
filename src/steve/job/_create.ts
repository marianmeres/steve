import type { Job, JobContext, JobCreateDTO } from "../jobs.ts";

export async function _create(
	context: JobContext,
	job: JobCreateDTO
): Promise<Job> {
	const { db, tableNames } = context;
	const { tableJobs } = tableNames;

	const { rows } = await db.query(
		`INSERT INTO ${tableJobs} (type, payload, max_attempts, backoff_strategy)
        VALUES ($1, $2, $3, $4)
        RETURNING *`,
		[
			job.type,
			JSON.stringify(job.payload ?? {}),
			job.max_attempts ?? null,
			job.backoff_strategy ?? null,
		]
	);

	return rows[0] as Job;
}
