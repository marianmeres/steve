// deno-lint-ignore-file no-explicit-any

export interface Logger {
	debug: (...args: any[]) => void;
	log: (...args: any[]) => void;
	warn: (...args: any[]) => void;
	error: (...args: any[]) => void;
}

/** Creates a conventional log output console-wrap */
export function createLogger(service: string, json = false) {
	const CONSOLE_TO_LEVEL = {
		debug: "DEBUG",
		log: "INFO",
		warn: "WARNING",
		error: "ERROR",
	};

	function _create(level: "debug" | "log" | "warn" | "error", ...args: any[]) {
		const message = args[0];
		const rest = args.slice(1);
		const timestamp = new Date().toISOString();

		if (json) {
			console[level](
				JSON.stringify({
					timestamp,
					level: CONSOLE_TO_LEVEL[level],
					service,
					message,
					...rest.reduce(
						(m, a, i) => ({ ...m, [`arg_${i}`]: a.stack ?? a }),
						{}
					),
				})
			);
		} else {
			console[level](
				`[${timestamp}] [${CONSOLE_TO_LEVEL[level]}] [${service}]`,
				message,
				...rest
			);
		}
	}

	return {
		debug: (...args: any[]) => _create("debug", ...args),
		log: (...args: any[]) => _create("log", ...args),
		warn: (...args: any[]) => _create("warn", ...args),
		error: (...args: any[]) => _create("error", ...args),
	};
}
