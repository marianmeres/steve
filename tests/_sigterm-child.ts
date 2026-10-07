/**
 * Child process for the SIGTERM lifecycle test (see fixes-v3.test.ts).
 *
 * Starts a Jobs instance with the DEFAULT `gracefulSigterm: true`, reports readiness,
 * then keeps the event loop alive on purpose: the only way for this process to end is
 * the re-raised SIGTERM's default action after `stop()` has finished.
 */
import { Jobs } from "../src/mod.ts";
import { createPg } from "./_pg.ts";

const db = createPg();
const out = (m: unknown) => console.log(String(m));

const jobs = new Jobs({
	db,
	tablePrefix: "_sigterm_child_",
	pollTimeoutMs: 100,
	logger: { debug: out, error: out, warn: out, log: out },
});

await jobs.start(1);
console.log("STARTED");

setInterval(() => {}, 1_000);
