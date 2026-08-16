/**
 * Emits the catalog as language-neutral JSON.
 *
 * The TypeScript definitions are the source of truth — they carry typed
 * bindings and derivations that JSON cannot hold. But the *data* has to reach
 * the Python and Go clients too, and a catalog of 81 models transcribed by hand
 * into three languages desynchronises the first week someone adds a model.
 * So it is generated, and the gate fails if the checked-in file has drifted.
 *
 *   bun run docs:json
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { getModels, getProviders } from "../src/catalog";

const models = getModels()
	.map((model) => ({
		id: model.id,
		provider: model.provider,
		category: model.category,
		name: model.name,
		inputType: model.inputType,
		durations: model.durationOptions,
		minDuration: model.minDuration,
		maxDuration: model.maxDuration,
		resolutions: model.supportedResolutions,
		aspectRatios: model.supportedAspectRatios,
		pricing: model.pricing,
		description: model.description,
	}))
	// Sorted so a regeneration produces a byte-identical file and the gate's
	// drift check compares content rather than ordering.
	.sort((a, b) => a.id.localeCompare(b.id));

const doc = {
	$comment:
		"Generated from the TypeScript catalog. Do not edit by hand — run docs:json.",
	generatedFrom: "sdks/node",
	providers: getProviders(),
	counts: models.reduce<Record<string, number>>((acc, model) => {
		acc[model.category] = (acc[model.category] ?? 0) + 1;
		return acc;
	}, {}),
	models,
};

const target = join(import.meta.dir, "..", "..", "..", "catalog", "catalog.json");
writeFileSync(target, `${JSON.stringify(doc, null, "\t")}\n`);
console.log(
	`catalog/catalog.json: ${models.length} models across ${doc.providers.length} providers`,
);
