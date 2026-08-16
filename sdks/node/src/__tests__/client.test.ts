import { beforeEach, describe, expect, it } from "bun:test";
import { registerModels, resetCatalog } from "../catalog";
import { brotuClient } from "../client";
import type { AIModelConfig } from "../constants/model.types";

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

describe("brotuClient", () => {
	beforeEach(() => {
		resetCatalog();
	});

	it("refuses to build a client with no keys", () => {
		expect(() => brotuClient({ providers: {} })).toThrow(
			/at least one provider/,
		);
	});

	it("exposes the models the configured keys can run", () => {
		const ai = brotuClient({ providers: { kling: { apiKey: "k" } } });
		const ids = ai.models().map((model) => model.id);
		expect(ids).toContain("kling/v2-6");
		expect(ids).toContain("kling/image-v2");
	});
});

describe("the data/error contract", () => {
	beforeEach(() => {
		resetCatalog();
	});

	const ai = () => brotuClient({ providers: { kling: { apiKey: "k" } } });

	it("reports an unknown model as data:null with a code", async () => {
		const { data, error } = await ai().video.submit({
			prompt: "x",
			model: "not-a-model",
		});

		expect(data).toBeNull();
		expect(error?.code).toBe("unknown_model");
		expect(error?.model).toBe("not-a-model");
	});

	it("reports a missing key rather than throwing", async () => {
		registerModels([OTHER_MODEL]);
		const { data, error } = await ai().image.submit({
			prompt: "x",
			model: OTHER_MODEL.id,
		});

		expect(data).toBeNull();
		expect(error?.code).toBe("missing_key");
	});

	it("reports a provider with no adapter", async () => {
		registerModels([
			{ ...OTHER_MODEL, id: "test/no-adapter", provider: "somevendor" },
		]);
		const { data, error } = await brotuClient({
			providers: {
				somevendor: { apiKey: "s", baseUrl: "https://api.example.com" },
			},
		}).image.submit({ prompt: "x", model: "test/no-adapter" });

		expect(data).toBeNull();
		expect(error?.code).toBe("unsupported_provider");
	});

	it("says a model is required instead of inventing a default", async () => {
		const { data, error } = await ai().video.submit({ prompt: "x" });

		expect(data).toBeNull();
		expect(error?.code).toBe("invalid_request");
	});

	it("never rejects: a routing failure is a value, not a throw", async () => {
		// The bug this contract exists to prevent — the promise must settle.
		await expect(
			ai().video.generate({ prompt: "x", model: "not-a-model" }),
		).resolves.toBeDefined();
	});

	it("returns an already-settled job without calling the provider", async () => {
		const { data } = await ai().jobs.poll({
			id: "inline-1",
			provider: "kling",
			model: "kling/v2-6",
			kind: "video",
			params: { prompt: "x" },
			submittedAt: new Date(0).toISOString(),
			result: {
				success: true,
				outputs: [
					{ url: "https://x/v.mp4", mimeType: "video/mp4", sizeBytes: 0 },
				],
				creditsUsed: 0,
				provider: "kling",
				model: "kling/v2-6",
				processingTimeMs: 1,
			},
		});

		expect(data?.status).toBe("succeeded");
		expect(data?.result?.outputs[0]?.url).toBe("https://x/v.mp4");
	});
});
