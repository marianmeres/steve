/**
 * @module @marianmeres/steve
 *
 * PostgreSQL-based job processing manager for Deno and Node.js.
 *
 * Steve provides a robust job queue system with support for concurrent workers,
 * job scheduling, configurable retry logic with exponential backoff, database
 * resilience with automatic retries, and comprehensive health monitoring.
 *
 * @example
 * ```typescript
 * import { Jobs } from "@marianmeres/steve";
 *
 * const jobs = new Jobs({
 *   db: pgPool,
 *   jobHandler: async (job) => {
 *     // Process the job
 *     return { success: true };
 *   },
 * });
 *
 * await jobs.start(2); // Start with 2 concurrent workers
 * await jobs.create("my_job", { data: "payload" });
 * ```
 */

export * from "./steve/jobs.ts";
export * from "./steve/utils/with-db-retry.ts";
export * from "./steve/utils/db-health.ts";
