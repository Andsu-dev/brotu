/**
 * The shortest useful path: a Brotu key, then generate.
 *
 *   BROTU_API_KEY=... KLING_API_KEY=... bun run examples/01-basics.ts
 */
import { brotu } from "../src";

const ai = brotu({
	apiKey: process.env.BROTU_API_KEY ?? "",
	providers: {
		kling: { apiKey: process.env.KLING_API_KEY ?? "" },
	},
});

// Only the models this key can actually reach, ready for a picker.
for (const model of ai.models()) {
	console.log(
		`${model.id.padEnd(22)} ${model.category.padEnd(6)} ${(model.durationOptions ?? []).join("/")}s`,
	);
}

// generate() is submit + wait in one call. Fine in a script; wrong in a request
// handler, because it holds the connection open for the whole generation.
const { data, error } = await ai.video.generate({
	model: "kling/v2-6",
	prompt: "a cat wearing sunglasses, cinematic, slow dolly in",
	duration: 5,
	aspectRatio: "16:9",
});

if (error) {
	// Nothing throws. `data` is unusable until you have narrowed on `error`.
	console.error(`${error.code}: ${error.message}`);
	process.exit(1);
}

console.log(data.outputs[0]?.url);
console.log(`${data.provider} · ${data.model} · ${data.processingTimeMs}ms`);
