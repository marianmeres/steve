import { npmBuild } from "@marianmeres/npmbuild";

const denoJson = JSON.parse(Deno.readTextFileSync("deno.json"));

await npmBuild({
	name: denoJson.name,
	version: denoJson.version,
	repository: denoJson.name.replace(/^@/, ""),
	dependencies: [
		"@marianmeres/clog",
		"@marianmeres/data-to-sql-params",
		"@marianmeres/parse-boolean",
		"@marianmeres/pubsub",
	],
});
