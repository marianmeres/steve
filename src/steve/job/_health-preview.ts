import { and, EMPTY, inList, raw, sql } from "@marianmeres/sqlkit";
import type { HealthPreviewRow, JobContext } from "../jobs.ts";

/** Will collect some basic stats about the jobs since `sinceHours` */
export async function _healthPreview(
	context: JobContext,
	sinceMinutesAgo = 60,
	tenantIds: string[] | null = null,
): Promise<HealthPreviewRow[]> {
	const { db, tableNames } = context;
	const { tableJobs } = tableNames;

	sinceMinutesAgo = parseInt(`${sinceMinutesAgo}`, 10);
	if (Number.isNaN(sinceMinutesAgo)) {
		sinceMinutesAgo = 60;
	}

	// The time window is always there, so `and()` never comes back empty.
	const where = and(
		sql`created_at > NOW() - (${sinceMinutesAgo}::bigint || ' minutes')::interval`,
		tenantIds?.length ? sql`tenant_id IN ${inList(tenantIds)}` : EMPTY,
	);

	const { rows } = await db.query<HealthPreviewRow>(
		sql`SELECT
			status,
			COUNT(*) as count,
			AVG(EXTRACT(EPOCH FROM (completed_at - started_at))) as avg_duration_seconds
		FROM ${raw(tableJobs)}
		WHERE ${where}
		GROUP BY status;`,
	);

	return rows;
}
