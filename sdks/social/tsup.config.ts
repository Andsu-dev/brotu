import { defineConfig } from "tsup";

export default defineConfig({
	// One entry per subpath export: the provider a project never imports should
	// never end up in its bundle.
	entry: [
		"src/index.ts",
		"src/providers/meta.ts",
		"src/providers/youtube.ts",
		"src/providers/tiktok.ts",
		"src/providers/linkedin.ts",
		"src/providers/x.ts",
	],
	format: ["esm", "cjs"],
	// Declarations come from tsc, not tsup — same reason as @brotu/ai.
	dts: false,
	clean: true,
	target: "node18",
});
