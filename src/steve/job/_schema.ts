import { BACKOFF_STRATEGY, JOB_STATUS, type JobContext } from "../jobs.ts";
import { withTransaction } from "../utils/with-transaction.ts";

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
			max_attempt_duration_ms INTEGER DEFAULT 0,
			tenant_id       	VARCHAR(255),
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
			job_id          	INTEGER NOT NULL,
			attempt_number  	INTEGER NOT NULL,
			started_at      	TIMESTAMPTZ DEFAULT NOW(),
			completed_at    	TIMESTAMPTZ,
			status          	VARCHAR(20), -- see ATTEMPT_STATUS
			error_message   	TEXT,
			error_details   	JSONB,

			FOREIGN KEY (job_id) REFERENCES ${tableJobs}(id) ON UPDATE CASCADE ON DELETE CASCADE
		);

		-- Self-heal: add tenant_id to an already-deployed __job table (steve has no
		-- migration ledger, so the schema blob is re-run on every fresh process and
		-- must converge any starting state). Nullable, no default => metadata-only on
		-- a populated table (instant, no rewrite); legacy rows read back NULL. MUST
		-- precede the tenant index below (the index references the column).
		ALTER TABLE ${tableJobs} ADD COLUMN IF NOT EXISTS tenant_id VARCHAR(255);

		CREATE INDEX IF NOT EXISTS idx_${safe(tableJobs)}_status_run_at ON ${tableJobs}(status, run_at);
		CREATE INDEX IF NOT EXISTS idx_${safe(tableJobs)}_uid ON ${tableJobs}(uid);
		CREATE INDEX IF NOT EXISTS idx_${safe(tableJobs)}_status ON ${tableJobs}(status);
		CREATE INDEX IF NOT EXISTS idx_${safe(tableAttempts)}_job_id ON ${tableAttempts}(job_id);

		-- PARTIAL composite, tenant_id-first per ecosystem convention. The predicate
		-- excludes NULL rows, so a tenant-unaware deployment (every tenant_id NULL)
		-- posts ZERO index entries => ~zero write cost. Tenant audit reads always
		-- filter "tenant_id = ..." (implicitly NOT NULL), so they match it perfectly.
		CREATE INDEX IF NOT EXISTS idx_${safe(tableJobs)}_tenant ON ${tableJobs}(tenant_id, created_at) WHERE tenant_id IS NOT NULL;
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

	await withTransaction(db, async (client) => {
		await client.query(sql);
	});
}

export async function _uninstall(context: JobContext): Promise<void> {
	const { db } = context;
	await withTransaction(db, async (client) => {
		await client.query(_schemaDrop(context));
	});
}
