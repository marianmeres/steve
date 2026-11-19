import { insert, json, raw } from "@marianmeres/sqlkit";
import type { Job, JobAwareFn, JobContext, JobCreateDTO } from "../jobs.ts";

/** Coerce/validate `run_at` inputs; throws a clear error for invalid dates. */
function normalizeRunAt(v: unknown): string | null {
	if (v === null || v === undefined || v === "") return null;
	const d = v instanceof Date ? v : new Date(v as string | number);
	if (Number.isNaN(d.getTime())) {
		throw new TypeError(
			`Invalid 'run_at' value: ${JSON.stringify(v)} is not a valid Date`,
		);
	}
	return d.toISOString();
}

export async function _create(
	context: JobContext,
	data: JobCreateDTO,
	onDone?: JobAwareFn,
): Promise<Job> {
	const { db, tableNames } = context;
	const { tableJobs } = tableNames;

	if (!data?.type || typeof data.type !== "string") {
		throw new TypeError(`'type' is required and must be a non-empty string`);
	}

	const runAt = normalizeRunAt(data.run_at); // throws on an invalid date

	// A key whose value is `undefined` is left out of the INSERT, so its column
	// default applies.
	const row = {
		type: data.type,
		// `json()` is `JSON.stringify`, as node-postgres did; a bare class instance
		// would be refused by the driver's parameter rule.
		payload: data.payload === undefined ? undefined : json(data.payload),
		max_attempts: data.max_attempts,
		backoff_strategy: data.backoff_strategy,
		max_attempt_duration_ms: data.max_attempt_duration_ms,
		// null and "" mean "not scheduled": left out, so the column default (NOW())
		// applies. Binding NULL would leave a job the claim never picks up.
		run_at: runAt ?? undefined,
		// No tenant: left out, so the column is NULL. A provided value is clamped to
		// the VARCHAR(255) width.
		tenant_id:
			data.tenant_id == null || data.tenant_id === ""
				? undefined
				: `${data.tenant_id}`.slice(0, 255),
	};

	// The table goes in as `raw()`: a prefix may be a schema ("app.") and an unquoted
	// name folds to lower case, which `ident()` or a plain string would change.
	const { rows } = await db.query<Job>(insert(raw(tableJobs), row, { returning: "*" }));
	const job = rows[0] as Job;

	if (typeof onDone === "function") {
		if (!context.onDoneCallbacks.has(job.uid)) {
			context.onDoneCallbacks.set(job.uid, new Set());
		}
		context.onDoneCallbacks.get(job.uid)?.add(onDone);
	}

	return job;
}
