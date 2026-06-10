import type { HealthPreviewRow, JobContext } from "../jobs.ts";

/** Will collect some basic stats about the jobs since `sinceHours` */
export async function _healthPreview(
	context: JobContext,
	sinceMinutesAgo = 60,
	tenantIds: string[] | null = null
): Promise<HealthPreviewRow[]> {
	const { db, tableNames } = context;
	const { tableJobs } = tableNames;

	sinceMinutesAgo = parseInt(`${sinceMinutesAgo}`);
	if (Number.isNaN(sinceMinutesAgo)) {
		sinceMinutesAgo = 60;
	}

	// `sinceMinutesAgo` is a guarded integer (safe to interpolate); the tenant
	// values are caller-supplied and MUST be bound, never interpolated.
	const conditions = [`created_at > NOW() - INTERVAL '${sinceMinutesAgo} minute'`];
	const params: unknown[] = [];
	if (tenantIds && tenantIds.length) {
		params.push(tenantIds);
		conditions.push(`tenant_id = ANY($${params.length}::varchar[])`);
	}

	const { rows } = await db.query(
		`SELECT
			status,
			COUNT(*) as count,
			AVG(EXTRACT(EPOCH FROM (completed_at - started_at))) as avg_duration_seconds
		FROM ${tableJobs}
		WHERE ${conditions.join(" AND ")}
		GROUP BY status;`,
		params.length ? params : undefined
	);

	return rows;
}
