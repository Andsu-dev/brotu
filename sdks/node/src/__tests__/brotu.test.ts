import { afterEach, describe, expect, it, mock } from "bun:test";
import { BrotuAdapter, PLATFORM_MODEL_IDS } from "../adapters/brotu.adapter";
import { brotu } from "../client";
import { isPendingJob, runInSubmitMode } from "../lib/jobs";

describe("platform model aliases", () => {
	it("maps the ids that do not already match the studio catalog", () => {
		expect(PLATFORM_MODEL_IDS["kling/v2-6"]).toBe("kling-2.6");
		expect(PLATFORM_MODEL_IDS["dreamina-seedance-2-5-260628"]).toBe(
			"bytedance/seedance-2-5",
		);
	});
});

describe("BrotuAdapter", () => {
	afterEach(() => {
		mock.restore();
	});

	it("submits an image and returns the generation handle", async () => {
		const fetchMock = mock((input: string | URL, init?: RequestInit) => {
			const url = String(input);
			if (url.includes("/default-workspace")) {
				return Promise.resolve(
					new Response(JSON.stringify({ workspaceId: "ws-1" }), { status: 200 }),
				);
			}
			if (url.includes("/studio/images") && init?.method === "POST") {
				const body = JSON.parse(String(init.body)) as { model: string };
				expect(body.model).toBe("gpt-image-2");
				return Promise.resolve(
					new Response(JSON.stringify({ generationId: "gen-1" }), {
						status: 202,
					}),
				);
			}
			return Promise.resolve(new Response("unhandled", { status: 500 }));
		});
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		const adapter = new BrotuAdapter({ apiKey: "brotu_sk_test" });
		try {
			await runInSubmitMode(() =>
				adapter.generateImage({
					model: "gpt-image-2",
					prompt: "a cat",
				}),
			);
			throw new Error("expected PendingJob");
		} catch (error) {
			expect(isPendingJob(error)).toBe(true);
			if (isPendingJob(error)) {
				expect(error.taskId).toBe("gen-1");
				expect(error.pollEndpoint).toContain("workspaceId=ws-1");
			}
		}
	});

	it("polls until the generation completes", async () => {
		let polls = 0;
		const fetchMock = mock((input: string | URL) => {
			const url = String(input);
			if (url.includes("/generations/gen-1")) {
				polls += 1;
				if (polls === 1) {
					return Promise.resolve(
						new Response(
							JSON.stringify({ generationId: "gen-1", status: "processing" }),
							{ status: 200 },
						),
					);
				}
				return Promise.resolve(
					new Response(
						JSON.stringify({
							generationId: "gen-1",
							status: "completed",
							creditsUsed: 4,
							outputs: { images: ["https://cdn.example/out.png"] },
						}),
						{ status: 200 },
					),
				);
			}
			return Promise.resolve(new Response("unhandled", { status: 500 }));
		});
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		const adapter = new BrotuAdapter({
			apiKey: "brotu_sk_test",
			workspaceId: "ws-1",
		});
		const snapshot = await adapter.completeJob({
			id: "gen-1",
			provider: "brotu",
			model: "gpt-image-2",
			kind: "image",
			params: { prompt: "a cat" },
			submittedAt: new Date(0).toISOString(),
			pollEndpoint: "/api/v1/studio/generations/gen-1?workspaceId=ws-1",
		});
		expect(snapshot.status).toBe("pending");

		const done = await adapter.completeJob({
			id: "gen-1",
			provider: "brotu",
			model: "gpt-image-2",
			kind: "image",
			params: { prompt: "a cat" },
			submittedAt: new Date(0).toISOString(),
			pollEndpoint: "/api/v1/studio/generations/gen-1?workspaceId=ws-1",
		});
		expect(done.status).toBe("succeeded");
		expect(done.result?.outputs[0]?.url).toBe("https://cdn.example/out.png");
		expect(done.result?.creditsUsed).toBe(4);
	});

	it("refuses speech and text without a vendor key", async () => {
		const adapter = new BrotuAdapter({ apiKey: "brotu_sk_test" });
		const audio = await adapter.generateAudio({
			model: "eleven_multilingual_v2",
			prompt: "hi",
		});
		expect(audio.success).toBe(false);
		expect(audio.error).toMatch(/vendor/);
	});
});

describe("client routing", () => {
	afterEach(() => {
		mock.restore();
	});

	it("prefers a vendor key over the Brotu fallback", async () => {
		const fetchMock = mock(() =>
			Promise.resolve(new Response("should not hit brotu", { status: 500 })),
		);
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		const { error } = await brotu({
			apiKey: "brotu_sk_test",
			providers: { kling: { apiKey: "k" } },
		}).video.submit({
			model: "not-a-model",
			prompt: "x",
		});
		expect(error?.code).toBe("unknown_model");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("sends Kling through Brotu when no Kling key is set", async () => {
		const fetchMock = mock((input: string | URL, init?: RequestInit) => {
			const url = String(input);
			if (url.includes("/default-workspace")) {
				return Promise.resolve(
					new Response(JSON.stringify({ workspaceId: "ws-1" }), { status: 200 }),
				);
			}
			if (url.includes("/studio/videos") && init?.method === "POST") {
				const body = JSON.parse(String(init.body)) as { model: string };
				expect(body.model).toBe("kling-2.6");
				return Promise.resolve(
					new Response(JSON.stringify({ generationId: "gen-9" }), {
						status: 202,
					}),
				);
			}
			return Promise.resolve(new Response("unhandled", { status: 500 }));
		});
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		const { data, error } = await brotu({
			apiKey: "brotu_sk_test",
		}).video.submit({
			model: "kling/v2-6",
			prompt: "a cat",
			duration: 5,
		});

		expect(error).toBeNull();
		expect(data?.provider).toBe("brotu");
		expect(data?.id).toBe("gen-9");
	});
});
