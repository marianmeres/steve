import { BACKOFF_STRATEGY, JOB_STATUS, type JobContext } from "../jobs.ts";

export function _schemaDrop(context: Pick<JobContext, "tableNames">): string {
	const { tableNames } = context;
	const { tableJobs, tableAttempts } = tableNames;

	return `
		DROP TABLE IF EXISTS ${tableAttempts}; 
		DROP TABLE IF EXISTS ${tableJobs};
	`;
}

export function _schemaCreate(context: Pick<JobContext, "tableNames">): string {
	const { tableNames } = context;
	const { tableJobs, tableAttempts } = tableNames;

	// so we can work with "schema." prefix in naming things...
	const safe = (name: string) => `${name}`.replace(/\W/g, "");

	// prettier-ignore
	return `
		CREATE TABLE IF NOT EXISTS ${tableJobs} (
			id              	SERIAL PRIMARY KEY,
			uid             	UUID NOT NULL DEFAULT gen_random_uuid(),
			type            	VARCHAR(255) NOT NULL,
			payload         	JSONB NOT NULL DEFAULT '{}',
			status          	VARCHAR(20) NOT NULL DEFAULT '${JOB_STATUS.PENDING}',
			result          	JSONB NOT NULL DEFAULT '{}',
			attempts        	INTEGER DEFAULT 0,
			max_attempts    	INTEGER DEFAULT 3,
			created_at      	TIMESTAMPTZ DEFAULT NOW(),
			updated_at      	TIMESTAMPTZ DEFAULT NOW(),
			run_at          	TIMESTAMPTZ DEFAULT NOW(),
			started_at      	TIMESTAMPTZ,
			completed_at    	TIMESTAMPTZ,
			backoff_strategy 	VARCHAR(20) NOT NULL DEFAULT '${BACKOFF_STRATEGY.EXP}'
		);

		-- This is a debug log table
		CREATE TABLE IF NOT EXISTS ${tableAttempts} (
			id              	SERIAL PRIMARY KEY,
			job_id          	INTEGER REFERENCES ${tableJobs}(id),
			attempt_number  	INTEGER NOT NULL,
			started_at      	TIMESTAMPTZ DEFAULT NOW(),
			completed_at    	TIMESTAMPTZ,
			status          	VARCHAR(20), -- see ATTEMPT_STATUS
			error_message   	TEXT,
			error_details   	JSONB
		);

		CREATE INDEX IF NOT EXISTS idx_${safe(tableJobs)}_status_run_at ON ${tableJobs}(status, run_at);
		CREATE INDEX IF NOT EXISTS idx_${safe(tableJobs)}_uid ON ${tableJobs}(uid);
		CREATE INDEX IF NOT EXISTS idx_${safe(tableJobs)}_status ON ${tableJobs}(status);
		CREATE INDEX IF NOT EXISTS idx_${safe(tableAttempts)}_job_id ON ${tableAttempts}(job_id);
	`;
}

export async function _initialize(
	context: JobContext,
	hard = false
): Promise<void> {
	const { db } = context;
	const sql = [hard && _schemaDrop(context), _schemaCreate(context)]
		.filter(Boolean)
		.join("\n");

	await db.query(sql);
}

export async function _uninstall(context: JobContext): Promise<void> {
	const { db } = context;
	await db.query(_schemaDrop(context));
}
