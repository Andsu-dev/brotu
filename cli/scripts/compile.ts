/**
 * Build a standalone `brotu` binary for this machine.
 *
 *   bun run compile
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const OUT_DIR = join(ROOT, "dist-bin");

function targetName(): string {
	const os =
		process.platform === "darwin"
			? "darwin"
			: process.platform === "linux"
				? "linux"
				: process.platform;
	const arch = process.arch === "arm64" ? "arm64" : process.arch;
	return `brotu-${os}-${arch}`;
}

mkdirSync(OUT_DIR, { recursive: true });
const outfile = join(OUT_DIR, targetName());

const result = Bun.spawnSync(
	["bun", "build", "--compile", "--outfile", outfile, join(ROOT, "src/index.ts")],
	{ cwd: ROOT, stdout: "inherit", stderr: "inherit" },
);

if (result.exitCode !== 0) {
	process.exit(result.exitCode ?? 1);
}

console.log(`wrote ${outfile}`);
