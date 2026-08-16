import { beforeEach, describe, expect, it } from "bun:test";
import {
	getAvailableModels,
	getModel,
	getProviders,
	registerModels,
	resetCatalog,
	resolveProvider,
} from "../catalog";
import { NATIVE_PROVIDERS } from "../client";
import type { AIModelConfig } from "../constants/model.types";
import type { BrotuAIOptions } from "../types";

const KLING_ONLY: BrotuAIOptions = { providers: { kling: { apiKey: "k" } } };

const OTHER_MODEL: AIModelConfig = {
	id: "test/elsewhere",
	name: "Elsewhere",
	category: "image",
	inputType: "text_only",
	nodeTypes: ["image_gen"],
	creditsPerUnit: 0,
	creditUnit: "image",
	provider: "elsewhere",
};

describe("catalog", () => {
	beforeEach(() => {
		resetCatalog();
	});

	it("never lists a model whose provider has no adapter", () => {
		// The invariant that matters: a catalog entry nothing can run is a lie.
		for (const provider of getProviders()) {
			expect(NATIVE_PROVIDERS as readonly string[]).toContain(provider);
		}
		expect(getProviders().length).toBeGreaterThan(0);
	});

	it("routes a model to the provider it declares", () => {
		const resolved = resolveProvider("kling/v2-6", KLING_ONLY);
		expect(resolved.id).toBe("kling");
		expect(resolved.apiKey).toBe("k");
		expect(resolved.baseUrl).toBe("https://api-singapore.klingai.com");
	});

	it("lets a regional or self-hosted deployment override the host", () => {
		const resolved = resolveProvider("kling/v2-6", {
			providers: {
				kling: { apiKey: "k", baseUrl: "https://api-beijing.klingai.com/" },
			},
		});
		expect(resolved.baseUrl).toBe("https://api-beijing.klingai.com");
	});

	it("refuses an unknown model instead of guessing", () => {
		expect(() => resolveProvider("nope", KLING_ONLY)).toThrow(/Unknown model/);
	});

	it("refuses to spend on a provider whose key is missing", () => {
		registerModels([OTHER_MODEL]);
		expect(() => resolveProvider(OTHER_MODEL.id, KLING_ONLY)).toThrow(
			/no API key was given/,
		);
	});

	it("requires a base URL for a provider it does not know", () => {
		registerModels([OTHER_MODEL]);
		expect(() =>
			resolveProvider(OTHER_MODEL.id, {
				providers: { elsewhere: { apiKey: "e" } },
			}),
		).toThrow(/no known base URL/);
	});

	it("patches a built-in entry instead of replacing it", () => {
		registerModels([{ id: "kling/v2-6", isNew: true } as AIModelConfig]);
		const model = getModel("kling/v2-6");
		expect(model?.isNew).toBe(true);
		expect(model?.provider).toBe("kling");
		expect(model?.category).toBe("video");
	});

	it("lists only models the configured keys can run", () => {
		registerModels([OTHER_MODEL]);
		const ids = getAvailableModels(KLING_ONLY).map((model) => model.id);
		expect(ids).not.toContain(OTHER_MODEL.id);
		expect(ids).toContain("kling/v2-6");
	});

	it("keeps registrations until the catalog is reset", () => {
		registerModels([OTHER_MODEL]);
		expect(getModel(OTHER_MODEL.id)).toBeDefined();
		resetCatalog();
		expect(getModel(OTHER_MODEL.id)).toBeUndefined();
	});

	it("gives every built-in model a provider, since nothing is implicit now", () => {
		for (const model of getAvailableModels({
			providers: { kling: { apiKey: "k" } },
		})) {
			expect(model.provider).toBeTruthy();
		}
	});
});
