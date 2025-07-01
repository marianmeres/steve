import { demino } from "@marianmeres/demino";
import { join } from "@std/path";
import pg from "pg";
import { Jobs, type Job } from "@marianmeres/steve";
import { sleep } from "../src/steve/utils/sleep.ts";

const { PG_HOST, PG_DATABASE, PG_USER, PG_PASSWORD, PG_PORT } = {
	PG_HOST: Deno.env.get("EXAMPLE_PG_HOST") || "localhost",
	PG_DATABASE: Deno.env.get("EXAMPLE_PG_DATABASE"),
	PG_USER: Deno.env.get("EXAMPLE_PG_USER"),
	PG_PASSWORD: Deno.env.get("EXAMPLE_PG_PASSWORD"),
	PG_PORT: Deno.env.get("EXAMPLE_PG_PORT") || "5432",
};

const db = new pg.Pool({
	host: PG_HOST,
	user: PG_USER,
	database: PG_DATABASE,
	password: PG_PASSWORD,
	port: parseInt(PG_PORT),
});

const INDEX_HTML = join(import.meta.dirname!, "index.html");

const TYPES = ["foo", "bar", "baz", "bat"];

const jobs = new Jobs({
	db,
	tablePrefix: "example_",
	async jobHandler(_job: Job) {
		if (Math.random() <= 0.5) {
			throw new Error("Example error");
		}
		await sleep(Math.max(200, Math.random() * 2_000));
		return { foo: Math.random().toString(36).slice(2) };
	},
});

jobs.onFailure("*", (j: Job) => {
	console.log("FAILED", j.id);
});

async function main() {
	await jobs.start(2);

	// keep spawning some dummy jobs...
	async function spawn() {
		const type = TYPES.at(getRandomIntInclusive(0, TYPES.length - 1))!;
		await jobs.create(type, {}, { max_attempts: 2 });
		await sleep(Math.max(300, Math.random() * 3_000));
		spawn();
	}
	spawn();

	//
	const app = demino("", [
		(_r, _i, c) => {
			c.locals.jobs = jobs;
		},
	]);

	app.get("/", () => Deno.readTextFile(INDEX_HTML));

	app.get("/jobs", (r, _i, c) => {
		const q = Object.fromEntries(new URL(r.url).searchParams.entries());
		return c.locals.jobs.fetchAll(null, q);
	});

	app.get("/job/[uid]", (_r, _i, c) => c.locals.jobs.find(null, c.params.uid));

	app.get("/health", (_r, _i, c) => c.locals.jobs.healthPreview(15));

	Deno.serve(app);
}

if (import.meta.main) {
	main();
}

// prettier-ignore
function getRandomIntInclusive(min: number, max: number): number {
    const minCeiled = Math.ceil(min);
    const maxFloored = Math.floor(max);
    return Math.floor(Math.random() * (maxFloored - minCeiled + 1) + minCeiled);
}
