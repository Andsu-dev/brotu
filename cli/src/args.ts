export type FlagValue = string | boolean;

export interface ParsedCli {
	command: string;
	subcommand?: string;
	positionals: string[];
	flags: Record<string, FlagValue>;
}

const ALIASES: Record<string, string> = {
	m: "model",
	o: "out",
	h: "help",
	j: "json",
};

export function flagString(
	flags: Record<string, FlagValue>,
	name: string,
): string | undefined {
	const value = flags[name];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function flagBool(
	flags: Record<string, FlagValue>,
	name: string,
): boolean {
	return flags[name] === true || flags[name] === "true";
}

export function flagNumber(
	flags: Record<string, FlagValue>,
	name: string,
): number | undefined {
	const raw = flagString(flags, name);
	if (raw === undefined) return undefined;
	const value = Number(raw);
	return Number.isFinite(value) ? value : undefined;
}

export function parseArgs(argv: string[]): ParsedCli {
	const flags: Record<string, FlagValue> = {};
	const positionals: string[] = [];
	let command = "";
	let subcommand: string | undefined;

	for (let i = 0; i < argv.length; i++) {
		const token = argv[i];
		if (!token) continue;

		if (token === "--") {
			positionals.push(...argv.slice(i + 1));
			break;
		}

		if (token.startsWith("--")) {
			const cut = token.slice(2);
			const eq = cut.indexOf("=");
			if (eq >= 0) {
				flags[cut.slice(0, eq)] = cut.slice(eq + 1);
				continue;
			}
			const next = argv[i + 1];
			if (next && !next.startsWith("-")) {
				flags[cut] = next;
				i++;
			} else {
				flags[cut] = true;
			}
			continue;
		}

		if (token.startsWith("-") && token.length === 2) {
			const name = ALIASES[token.slice(1)] ?? token.slice(1);
			const next = argv[i + 1];
			if (name === "help" || name === "json" || name === "wait") {
				flags[name] = true;
				continue;
			}
			if (next && !next.startsWith("-")) {
				flags[name] = next;
				i++;
			} else {
				flags[name] = true;
			}
			continue;
		}

		if (!command) {
			command = token;
			continue;
		}
		if (command === "job" && !subcommand) {
			subcommand = token;
			continue;
		}
		positionals.push(token);
	}

	return { command, subcommand, positionals, flags };
}
