import { describe, expect, it } from "bun:test";
import { brotu } from "../client";
import type { HookEvent } from "../lib/hooks";
import type { Job } from "../lib/jobs";

const settledJob = (id = "inline-1"): Job => ({
	id,
	provider: "kling",
	model: "kling/v2-6",
	kind: "video",
	params: { prompt: "x" },
	submittedAt: new Date(0).toISOString(),
	result: {
		success: true,
		outputs: [{ url: "https://x/v.mp4", mimeType: "video/mp4", sizeBytes: 0 }],
		creditsUsed: 0,
		provider: "kling",
		model: "kling/v2-6",
		processingTimeMs: 12,
	},
});

describe("hooks", () => {
	it("fires onVideoSuccess once for a settled video job", async () => {
		const seen: HookEvent[] = [];
		const ai = brotu({
			apiKey: "brotu_sk_test",
			providers: { kling: { apiKey: "k" } },
			hooks: { onVideoSuccess: (e) => void seen.push(e) },
		});

		const job = settledJob();
		await ai.jobs.poll(job);
		await ai.jobs.poll(job);

		expect(seen).toHaveLength(1);
		expect(seen[0]?.kind).toBe("video");
		expect(seen[0]?.stage).toBe("Success");
		expect(seen[0]?.outputs?.[0]?.url).toBe("https://x/v.mp4");
	});

	it("leaves another kind's hook alone", async () => {
		let imageCalls = 0;
		const ai = brotu({
			apiKey: "brotu_sk_test",
			providers: { kling: { apiKey: "k" } },
			hooks: { onImageSuccess: () => void imageCalls++ },
		});

		await ai.jobs.poll(settledJob("inline-2"));

		expect(imageCalls).toBe(0);
	});

	it("does not fail the generation when the hook throws", async () => {
		const ai = brotu({
			apiKey: "brotu_sk_test",
			providers: { kling: { apiKey: "k" } },
			hooks: {
				onVideoSuccess: () => {
					throw new Error("mailer down");
				},
			},
		});

		const { data, error } = await ai.jobs.poll(settledJob("inline-3"));

		expect(error).toBeNull();
		expect(data?.status).toBe("succeeded");
	});

	it("fires onVideoLoading before the provider is called", async () => {
		const order: string[] = [];
		globalThis.fetch = (async () => {
			order.push("provider");
			return new Response("nope", { status: 500 });
		}) as unknown as typeof fetch;

		const ai = brotu({
			apiKey: "brotu_sk_test",
			providers: { kling: { apiKey: "k" } },
			hooks: {
				onVideoLoading: () => void order.push("loading"),
				onVideoError: () => void order.push("error"),
			},
		});

		await ai.video.generate({ prompt: "x", model: "kling/v2-6" });

		expect(order[0]).toBe("loading");
		expect(order.at(-1)).toBe("error");
	});
});
