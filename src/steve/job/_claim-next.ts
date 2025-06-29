import { type JobContext, JOB_STATUS } from "../jobs.ts";

/** Will ATOMIC-aly update (mark as running) and fetch next pending job. */
export async function _claimNextJob(context: JobContext) {
	const { db, tableNames } = context;
	const { tableJobs } = tableNames;

	const result = await db.query(`
        UPDATE ${tableJobs} 
        SET status = '${JOB_STATUS.RUNNING}', 
            started_at = NOW(),
            updated_at = NOW(),
            attempts = attempts + 1
        WHERE id = (
            SELECT id FROM ${tableJobs}  
            WHERE status = '${JOB_STATUS.PENDING}' 
            AND run_at <= NOW()
            ORDER BY id 
            FOR UPDATE SKIP LOCKED -- Important!
            LIMIT 1
        )
        RETURNING *`);

	return result.rows[0];
}
