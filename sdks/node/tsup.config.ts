import { defineConfig } from "tsup";

export default defineConfig({
	entry: ["src/index.ts", "src/catalog.ts"],
	format: ["esm", "cjs"],
	// Declarations come from tsc, not tsup: its bundled dts build breaks against
	// this TypeScript version, and tsc already has to run for the typecheck gate.
	dts: false,
	clean: true,
	// Node 18 is the floor: fetch, Buffer and node:async_hooks all exist there.
	target: "node18",
	// Optional peers stay external so a project that never configures storage or
	// Comfy does not pull them in.
	external: ["@aws-sdk/client-s3", "@aws-sdk/s3-request-presigner"],
});

