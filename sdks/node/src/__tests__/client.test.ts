import { beforeEach, describe, expect, it } from "bun:test";
import { registerModels, resetCatalog } from "../catalog";
import { brotu } from "../client";
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

describe("brotu", () => {
	beforeEach(() => {
		resetCatalog();
	});

	it("refuses to build a client without a Brotu API key", () => {
		expect(() =>
			brotu({ apiKey: "", providers: { kling: { apiKey: "k" } } }),
		).toThrow(/Brotu API key/);
	});

	it("lists the full catalog once a Brotu key is set", () => {
		const ai = brotu({ apiKey: "brotu_sk_test" });
		const ids = ai.models().map((model) => model.id);
		expect(ids).toContain("kling/v2-6");
		expect(ids).toContain("kling/image-v2");
		expect(ids).toContain("gpt-image-2");
	});
});

describe("the data/error contract", () => {
	beforeEach(() => {
		resetCatalog();
	});

	const ai = () =>
		brotu({ apiKey: "brotu_sk_test", providers: { kling: { apiKey: "k" } } });

	it("reports an unknown model as data:null with a code", async () => {
		const { data, error } = await ai().video.submit({
			prompt: "x",
			model: "not-a-model",
		});

		expect(data).toBeNull();
		expect(error?.code).toBe("unknown_model");
		expect(error?.model).toBe("not-a-model");
	});

	it("falls back to Brotu when the vendor key is missing", async () => {
		registerModels([OTHER_MODEL]);
		const fetchMock = async (input: string | URL) => {
			const url = String(input);
			if (url.includes("/default-workspace")) {
				return new Response(JSON.stringify({ workspaceId: "ws-1" }), {
					status: 200,
				});
			}
			if (url.includes("/studio/images")) {
				return new Response(JSON.stringify({ generationId: "gen-1" }), {
					status: 202,
				});
			}
			return new Response("not mocked", { status: 500 });
		};
		const previous = globalThis.fetch;
		globalThis.fetch = fetchMock as typeof fetch;
		try {
			const { data, error } = await ai().image.submit({
				prompt: "x",
				model: OTHER_MODEL.id,
			});
			expect(error).toBeNull();
			expect(data?.provider).toBe("brotu");
			expect(data?.id).toBe("gen-1");
		} finally {
			globalThis.fetch = previous;
		}
	});

	it("reports a provider with no adapter", async () => {
		registerModels([
			{ ...OTHER_MODEL, id: "test/no-adapter", provider: "somevendor" },
		]);
		const { data, error } = await brotu({
			apiKey: "brotu_sk_test",
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
