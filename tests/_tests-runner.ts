// deno-lint-ignore-file no-explicit-any

import pg from "pg";
import { createPg } from "./_pg.ts";

export function testsRunner(
	tests: {
		name: string;
		fn: (ctx: { db: pg.Client }) => void | Promise<void>;
		only?: boolean;
		ignore?: boolean;
		raw?: boolean;
	}[]
) {
	for (const def of tests) {
		const { name, ignore, only } = def;
		if (typeof def.fn !== "function") continue;
		Deno.test(
			{ name, ignore, only },
			def.raw
				? () => def.fn({ db: null as any })
				: async () => {
						const db = await createPg();
						try {
							await def.fn({ db });
						} catch (e) {
							throw e;
						} finally {
							await db?.end();
						}
				  }
		);
	}
}
