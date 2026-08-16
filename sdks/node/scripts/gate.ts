/**
 * The gate: everything that must be true before this code leaves the machine.
 *
 * It exists because of what actually went wrong while this package was being
 * built. Four live API keys passed through a working session and one nearly
 * landed in a file. Two adapters shipped a model list that did not match the
 * provider. A generated doc drifted from the catalog it describes. Each check
 * below is one of those, turned into something that fails loudly.
 *
 *   bun run gate
 */
import { execSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dir, "..");
const SCAN_DIRS = ["src", "examples", "scripts"];
const SCAN_FILES = [
	"README.md",
	"CATALOG.md",
	"package.json",
	"tsup.config.ts",
];

type Finding = { file: string; line: number; detail: string };

/**
 * Patterns for credentials this project has actually handled. Each is anchored
 * on a vendor's own prefix rather than on entropy, because a generic "looks
 * random" rule fires on every base64 fixture and gets switched off within a week.
 */
const SECRET_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
	{ name: "Kling API key", pattern: /\bapi-key-kling-[A-Za-z0-9._-]{10,}/ },
	{ name: "BytePlus Ark key", pattern: /\bark-[0-9a-f]{8}-[0-9a-f-]{20,}/ },
	{ name: "Qwen / DashScope key", pattern: /\bsk-ws-[A-Za-z0-9._-]{20,}/ },
	{ name: "OpenAI key", pattern: /\bsk-(proj-)?[A-Za-z0-9]{32,}/ },
	{ name: "Google API key", pattern: /\bAIza[0-9A-Za-z_-]{30,}/ },
	{ name: "ElevenLabs key", pattern: /\bsk_[0-9a-f]{40,}/ },
	{ name: "Mintlify key", pattern: /\bmint_[A-Za-z0-9]{20,}/ },
	{ name: "AWS access key id", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
	{ name: "private key block", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
];

/**
 * Things that are not secrets but should not ship in an open package: internal
 * hosts, and the monorepo this was extracted from.
 */
const LEAK_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
	{
		name: "internal Brotu host",
		// api.brotu.app is the public generation host the client calls.
		pattern: /\b(?!api\.)\w+\.brotu\.(app|com\.br)\b/,
	},
	// The package's own specifier is fine; any other @brotu/* is a monorepo leak.
	{
		name: "monorepo import",
		pattern: /from ["']@\/|from ["']@brotu\/(?!ai["'])/,
	},
	{ name: "absolute local path", pattern: /\/Users\/[a-z]+\// },
];

function walk(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir)) {
		if (entry === "node_modules" || entry === "dist" || entry.startsWith("."))
			continue;
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) out.push(...walk(full));
		else if (/\.(ts|tsx|js|mjs|cjs|json|md|ya?ml)$/.test(entry)) out.push(full);
	}
	return out;
}

function filesToScan(): string[] {
	const files: string[] = [];
	for (const dir of SCAN_DIRS) {
		try {
			files.push(...walk(join(ROOT, dir)));
		} catch {
			// A directory that does not exist is not a failure.
		}
	}
	for (const file of SCAN_FILES) {
		try {
			statSync(join(ROOT, file));
			files.push(join(ROOT, file));
		} catch {
			// Same.
		}
	}
	return files;
}

function scan(
	patterns: Array<{ name: string; pattern: RegExp }>,
	allow: (file: string, line: string) => boolean = () => false,
): Finding[] {
	const findings: Finding[] = [];
	for (const file of filesToScan()) {
		const lines = readFileSync(file, "utf8").split("\n");
		lines.forEach((line, index) => {
			if (allow(file, line)) return;
			for (const { name, pattern } of patterns) {
				if (pattern.test(line)) {
					findings.push({
						file: relative(ROOT, file),
						line: index + 1,
						detail: name,
					});
				}
			}
		});
	}
	return findings;
}

const checks: Array<{ name: string; run: () => string[] }> = [
	{
		name: "no credentials in the tree",
		run: () =>
			scan(SECRET_PATTERNS, (_file, line) =>
				// The gate's own pattern list necessarily contains the prefixes.
				line.includes("pattern:"),
			).map((f) => `${f.file}:${f.line} — ${f.detail}`),
	},
	{
		name: "nothing internal leaks into an open package",
		run: () =>
			scan(
				LEAK_PATTERNS,
				(file, line) =>
					file.endsWith("scripts/gate.ts") || line.trimStart().startsWith("//"),
			).map((f) => `${f.file}:${f.line} — ${f.detail}`),
	},
	{
		name: "types check",
		run: () => {
			try {
				execSync("bunx tsc --noEmit", { cwd: ROOT, stdio: "pipe" });
				return [];
			} catch (error) {
				return [
					String((error as { stdout?: Buffer }).stdout ?? error).slice(0, 800),
				];
			}
		},
	},
	{
		name: "lint passes",
		run: () => {
			try {
				execSync("bunx --bun biome lint src examples scripts", {
					cwd: ROOT,
					stdio: "pipe",
				});
				return [];
			} catch (error) {
				return [
					String((error as { stdout?: Buffer }).stdout ?? error).slice(0, 800),
				];
			}
		},
	},
	{
		name: "tests pass",
		run: () => {
			try {
				execSync("bun test", { cwd: ROOT, stdio: "pipe" });
				return [];
			} catch (error) {
				return [
					String((error as { stdout?: Buffer }).stdout ?? error).slice(0, 800),
				];
			}
		},
	},
	{
		name: "catalog.json matches the catalog",
		run: () => {
			const target = join(ROOT, "..", "..", "catalog", "catalog.json");
			const before = readFileSync(target, "utf8");
			execSync("bun run scripts/generate-catalog-json.ts", {
				cwd: ROOT,
				stdio: "pipe",
			});
			return before === readFileSync(target, "utf8")
				? []
				: [
						"catalog/catalog.json was stale. It has been regenerated — commit it. The Python and Go clients read this file.",
					];
		},
	},
	{
		name: "CATALOG.md matches the catalog",
		run: () => {
			const before = readFileSync(join(ROOT, "CATALOG.md"), "utf8");
			execSync("bun run scripts/generate-catalog-doc.ts", {
				cwd: ROOT,
				stdio: "pipe",
			});
			const after = readFileSync(join(ROOT, "CATALOG.md"), "utf8");
			return before === after
				? []
				: [
						"CATALOG.md was stale. It has been regenerated — commit the change.",
					];
		},
	},
];

/** A model the catalog offers but nothing can execute is a lie to the caller. */
async function catalogIsRunnable(): Promise<string[]> {
	const { getModels } = await import("../src/catalog");
	const { NATIVE_PROVIDERS } = await import("../src/client");
	const known = new Set<string>(NATIVE_PROVIDERS);

	return getModels()
		.filter((model) => !model.provider || !known.has(model.provider))
		.map((model) => `${model.id} points at "${model.provider ?? "nothing"}"`);
}

let failed = 0;
for (const check of checks) {
	const problems = check.run();
	if (problems.length === 0) {
		console.log(`  ok    ${check.name}`);
		continue;
	}
	failed++;
	console.log(`  FAIL  ${check.name}`);
	for (const problem of problems) console.log(`        ${problem}`);
}

const unrunnable = await catalogIsRunnable();
if (unrunnable.length === 0) {
	console.log("  ok    every catalog model has an adapter that can run it");
} else {
	failed++;
	console.log("  FAIL  every catalog model has an adapter that can run it");
	for (const problem of unrunnable) console.log(`        ${problem}`);
}

console.log();
if (failed > 0) {
	console.log(`${failed} check${failed === 1 ? "" : "s"} failed.`);
	process.exit(1);
}
console.log("Gate passed.");
