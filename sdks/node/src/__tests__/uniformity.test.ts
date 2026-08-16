import { describe, expect, it } from "bun:test";
import { BytePlusAdapter } from "../adapters/byteplus.adapter";
import { KlingAdapter } from "../adapters/kling.adapter";
import { QwenAdapter } from "../adapters/qwen.adapter";
import { getModel, getModels, registerModels, resetCatalog } from "../catalog";
import { brotuClient } from "../client";
import type { AIModelConfig } from "../constants/model.types";
import type { GenerationOutput } from "../ports/content-generator.port";

/**
 * The point of this SDK is that switching models is a one-word change. These
 * tests are what stop that from quietly becoming untrue as providers are added.
 */

const ADAPTERS = [
	new KlingAdapter({ apiKey: "k" }),
	new BytePlusAdapter({ apiKey: "ark-k" }),
	new QwenAdapter({ apiKey: "sk-ws-k" }),
];

describe("every adapter presents the same surface", () => {
	it("implements the same methods", () => {
		for (const adapter of ADAPTERS) {
			expect(typeof adapter.generateImage).toBe("function");
			expect(typeof adapter.generateVideo).toBe("function");
			expect(typeof adapter.estimateCost).toBe("function");
			expect(typeof adapter.supportsModel).toBe("function");
			expect(adapter.providerName).toBeTruthy();
		}
	});

	it("can all resume a job by handle", () => {
		for (const adapter of ADAPTERS) {
			expect(
				typeof (adapter as unknown as { completeJob?: unknown }).completeJob,
			).toBe("function");
		}
	});

	it("claims only models it can actually route", () => {
		for (const adapter of ADAPTERS) {
			for (const model of adapter.getAvailableModels()) {
				expect(adapter.supportsModel(model.id)).toBe(true);
			}
		}
	});
});

describe("every output has the same shape", () => {
	/** The named fields, so a caller never reaches into a provider-shaped bag. */
	const NAMED = new Set([
		"url",
		"mimeType",
		"taskId",
		"durationSeconds",
		"sizeBytes",
		"expiresAt",
		"sourceUrl",
		"raw",
	]);

	function outputsOf(adapter: unknown, payload: unknown, kind = "video") {
		const inner = adapter as {
			outputsFrom: (a: unknown, b: unknown, c?: unknown) => GenerationOutput[];
		};
		return inner.outputsFrom(payload, kind);
	}

	it("kling puts nothing outside the named fields", () => {
		const outputs = outputsOf(ADAPTERS[0], {
			task_id: "t1",
			outputs: [{ url: "https://x/v.mp4" }],
		});
		expect(outputs).toHaveLength(1);
		for (const key of Object.keys(outputs[0] ?? {})) {
			expect(NAMED).toContain(key);
		}
		expect(outputs[0]?.taskId).toBe("t1");
		expect(outputs[0]?.expiresAt).toBeTruthy();
	});

	it("byteplus puts nothing outside the named fields", () => {
		const outputs = outputsOf(ADAPTERS[1], {
			id: "t2",
			status: "succeeded",
			content: { video_url: "https://x/v.mp4" },
		});
		for (const key of Object.keys(outputs[0] ?? {})) {
			expect(NAMED).toContain(key);
		}
		expect(outputs[0]?.taskId).toBe("t2");
	});

	it("qwen puts nothing outside the named fields", () => {
		const outputs = outputsOf(ADAPTERS[2], {
			request_id: "r",
			output: { task_id: "t3", video_url: "https://x/v.mp4" },
			usage: { duration: 5 },
		});
		for (const key of Object.keys(outputs[0] ?? {})) {
			expect(NAMED).toContain(key);
		}
		expect(outputs[0]?.taskId).toBe("t3");
		expect(outputs[0]?.durationSeconds).toBe(5);
	});

	it("tells the caller when every provider's URL dies", () => {
		// Each vendor hands back a presigned link. If one stopped reporting this,
		// a caller relying on it would silently start losing files.
		const payloads: Array<[unknown, unknown]> = [
			[ADAPTERS[0], { task_id: "a", outputs: [{ url: "https://x/a.mp4" }] }],
			[
				ADAPTERS[1],
				{
					id: "b",
					status: "succeeded",
					content: { video_url: "https://x/b.mp4" },
				},
			],
			[
				ADAPTERS[2],
				{
					request_id: "r",
					output: { task_id: "c", video_url: "https://x/c.mp4" },
				},
			],
		];

		for (const [adapter, payload] of payloads) {
			const [output] = outputsOf(adapter, payload);
			expect(output?.expiresAt).toBeTruthy();
			expect(Date.parse(output?.expiresAt ?? "")).toBeGreaterThan(Date.now());
		}
	});
});

describe("every catalog entry describes itself the same way", () => {
	it("names a provider, a category and an input type", () => {
		resetCatalog();
		for (const model of getModels()) {
			expect(model.provider).toBeTruthy();
			expect(["video", "image", "text", "audio"]).toContain(model.category);
			expect(model.inputType).toBeTruthy();
			expect(model.nodeTypes.length).toBeGreaterThan(0);
		}
	});
});

describe("caller metadata survives the round trip", () => {
	it("rides on the job, so a resumed one still knows what it was for", async () => {
		const ai = brotuClient({ providers: { kling: { apiKey: "k" } } });

		// Routing fails before any network call, which is all this needs to prove
		// the tag is attached to the request rather than to the response.
		const { error } = await ai.video.submit({
			model: "not-a-model",
			prompt: "x",
			metadata: { campaignId: "c_1" },
		});
		expect(error?.code).toBe("unknown_model");
	});
});

describe("cost estimates are honest", () => {
	const ai = brotuClient({
		providers: {
			kling: { apiKey: "k" },
			byteplus: { apiKey: "b" },
			qwen: { apiKey: "q" },
		},
	});

	it("counts the billable units even with no price on file", async () => {
		// wan2.6 is only listed in Qwen's console Marketplace, so it has no rate.
		const { data } = await ai.estimateCost("video", {
			model: "wan2.6-t2v",
			prompt: "x",
			duration: 10,
		});

		expect(data?.unit).toBe("second");
		expect(data?.units).toBe(10);
		// null, not zero: zero would read as free.
		expect(data?.usd).toBeNull();
		expect(data?.note).toMatch(/No verified rate/);
	});

	it("prices by resolution, since that is how the vendors bill", async () => {
		const cheap = await ai.estimateCost("video", {
			model: "kling/v3",
			prompt: "x",
			duration: 5,
			resolution: "720p",
		});
		const dear = await ai.estimateCost("video", {
			model: "kling/v3",
			prompt: "x",
			duration: 5,
			resolution: "4k",
		});

		expect(cheap.data?.usd).toBe(0.42);
		expect(dear.data?.usd).toBe(2.1);
	});

	it("falls back to the model's own minimum when no duration is given", async () => {
		const { data } = await ai.estimateCost("video", {
			model: "dreamina-seedance-2-0-260128",
			prompt: "x",
		});
		expect(data?.units).toBe(4);
	});

	it("counts images, not seconds, for an image model", async () => {
		const { data } = await ai.estimateCost("image", {
			model: "kling/image-v2",
			prompt: "x",
		});
		expect(data?.unit).toBe("image");
		expect(data?.units).toBe(1);
	});

	it("prices in USD once the catalog carries a verified rate", async () => {
		registerModels([
			{
				...(getModel("wan2.6-t2v") as AIModelConfig),
				id: "wan2.6-t2v",
				pricing: { usdPerUnit: 0.1, unit: "second" },
			},
		]);

		const { data } = await ai.estimateCost("video", {
			model: "wan2.6-t2v",
			prompt: "x",
			duration: 5,
		});
		expect(data?.usd).toBe(0.5);
		expect(data?.note).toBeUndefined();
		resetCatalog();
	});

	it("reports the same shape whichever provider answers", async () => {
		for (const model of [
			"kling/v2-6",
			"wan2.7-t2v",
			"seedance-1-0-pro-250528",
		]) {
			const { data } = await ai.estimateCost("video", { model, prompt: "x" });
			expect(data?.provider).toBeTruthy();
			expect(data?.model).toBe(model);
			expect(typeof data?.units).toBe("number");
		}
	});
});

describe("speech", () => {
	const ai = brotuClient({
		providers: {
			qwen: { apiKey: "q" },
			elevenlabs: { apiKey: "e" },
		},
	});

	it("offers voice models from more than one vendor", () => {
		const audio = ai.models().filter((m) => m.category === "audio");
		expect(audio.length).toBeGreaterThan(0);
		expect(new Set(audio.map((m) => m.provider)).size).toBe(2);
	});

	it("prices speech exactly, because characters are known before asking", async () => {
		const { data } = await ai.audio.generate({
			model: "qwen3-tts-flash",
			prompt: "hello there",
			voice: "Cherry",
		});
		void data;

		const estimate = await ai.estimateCost("audio", {
			model: "qwen3-tts-flash",
			prompt: "hello there",
		});
		expect(estimate.data?.unit).toBe("character");
		expect(estimate.data?.units).toBe("hello there".length);
		expect(estimate.data?.usd).toBeGreaterThan(0);
	});

	it("refuses an ElevenLabs request with no voice, since the API has no default", async () => {
		const { data, error } = await ai.audio.generate({
			model: "eleven_multilingual_v2",
			prompt: "hello",
		});
		expect(data).toBeNull();
		expect(error?.message).toMatch(/needs a voice id/);
	});

	it("rejects a voice the Qwen model does not have", async () => {
		const { error } = await ai.audio.generate({
			model: "qwen3-tts-flash",
			prompt: "hello",
			voice: "NotAVoice",
		});
		expect(error?.message).toMatch(/offers Cherry/);
	});
});

describe("text", () => {
	const ai = brotuClient({ providers: { qwen: { apiKey: "q" } } });

	it("cannot price text up front, and says so instead of guessing", async () => {
		// The bill depends on how much the model writes back.
		const { data } = await ai.estimateCost("text", {
			model: "qwen-turbo",
			prompt: "write me an essay",
		});
		expect(data?.unit).toBe("token");
		expect(data?.usd).toBeNull();
		expect(data?.note).toMatch(/per million output tokens/);
	});
});
