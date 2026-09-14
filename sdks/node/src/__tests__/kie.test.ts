import { afterEach, describe, expect, it, mock } from "bun:test";
import { KieAdapter, kieSnapshot, parseKieCallback } from "../adapters/kie.adapter";
import { brotu } from "../client";
import { isPendingJob, runInSubmitMode } from "../lib/jobs";

const ok = (data: unknown, status = 200) =>
	Promise.resolve(
		new Response(JSON.stringify({ code: 200, msg: "success", data }), {
			status,
		}),
	);

describe("KieAdapter", () => {
	afterEach(() => {
		mock.restore();
	});

	it("creates a kling task with kie's own field names", async () => {
		let sent: Record<string, unknown> = {};
		globalThis.fetch = mock((input: string | URL, init?: RequestInit) => {
			expect(String(input)).toBe("https://api.kie.ai/api/v1/jobs/createTask");
			sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
			return ok({ taskId: "task-1" });
		}) as unknown as typeof fetch;

		const adapter = new KieAdapter({ apiKey: "kie_test" });
		try {
			await runInSubmitMode(() =>
				adapter.generateVideo({
					model: "kling/v2-6",
					prompt: "a cat",
					duration: 10,
					withAudio: true,
					imageUrl: "https://x/first.png",
					aspectRatio: "16:9",
				}),
			);
			throw new Error("expected PendingJob");
		} catch (error) {
			expect(isPendingJob(error)).toBe(true);
		}

		// image-to-video, because the request carried a first frame.
		expect(sent.model).toBe("kling-2.6/image-to-video");
		expect(sent.input).toEqual({
			prompt: "a cat",
			aspect_ratio: "16:9",
			duration: "10",
			sound: true,
			image_url: "https://x/first.png",
		});
	});

	it("maps seedance to its own spelling and merges providerOptions last", async () => {
		let sent: Record<string, unknown> = {};
		globalThis.fetch = mock((_input: string | URL, init?: RequestInit) => {
			sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
			return ok({ taskId: "task-2" });
		}) as unknown as typeof fetch;

		const adapter = new KieAdapter({ apiKey: "kie_test" });
		try {
			await runInSubmitMode(() =>
				adapter.generateVideo({
					model: "dreamina-seedance-2-5-260628",
					prompt: "x",
					duration: 5,
					resolution: "720p",
					withAudio: false,
					providerOptions: { kie: { return_last_frame: true, duration: 8 } },
				}),
			);
		} catch {
			// PendingJob, asserted elsewhere.
		}

		expect(sent.model).toBe("bytedance/seedance-2-5");
		expect(sent.input).toEqual({
			prompt: "x",
			duration: 8,
			resolution: "720p",
			generate_audio: false,
			return_last_frame: true,
		});
	});

	it("sends callBackUrl so the task never has to be polled", async () => {
		let sent: Record<string, unknown> = {};
		globalThis.fetch = mock((_input: string | URL, init?: RequestInit) => {
			sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
			return ok({ taskId: "task-3" });
		}) as unknown as typeof fetch;

		const adapter = new KieAdapter({
			apiKey: "kie_test",
			callbackUrl: "https://api.brotu.app/hooks/kie",
		});
		try {
			await runInSubmitMode(() =>
				adapter.generateImage({ model: "google/nano-banana", prompt: "x" }),
			);
		} catch {
			// PendingJob.
		}

		expect(sent.callBackUrl).toBe("https://api.brotu.app/hooks/kie");
	});

	it("reads outputs off a settled task", async () => {
		globalThis.fetch = mock((input: string | URL) => {
			expect(String(input)).toContain("/jobs/recordInfo?taskId=task-4");
			return ok({
				taskId: "task-4",
				model: "bytedance/seedance-2-5",
				state: "success",
				creditsConsumed: 42,
				resultJson: JSON.stringify({
					resultUrls: ["https://cdn.kie/v.mp4"],
				}),
			});
		}) as unknown as typeof fetch;

		const settled = await new KieAdapter({ apiKey: "kie_test" }).task("task-4");
		expect(settled.status).toBe("succeeded");
		expect(settled.outputs).toEqual([
			{ url: "https://cdn.kie/v.mp4", mimeType: "video/mp4" },
		]);
		expect(settled.creditsUsed).toBe(42);
	});

	it("surfaces the failure message instead of a silent empty result", async () => {
		globalThis.fetch = mock(() =>
			ok({ taskId: "task-5", state: "fail", failCode: 422, failMsg: "nsfw" }),
		) as unknown as typeof fetch;

		const settled = await new KieAdapter({ apiKey: "kie_test" }).task("task-5");
		expect(settled.status).toBe("failed");
		expect(settled.error).toBe("nsfw");
	});

	it("fails on a body-level error code even when HTTP says 200", async () => {
		globalThis.fetch = mock(() =>
			Promise.resolve(
				new Response(JSON.stringify({ code: 402, msg: "insufficient credit" }), {
					status: 200,
				}),
			),
		) as unknown as typeof fetch;

		const result = await new KieAdapter({ apiKey: "kie_test" }).generateImage({
			model: "google/nano-banana",
			prompt: "x",
		});
		expect(result.success).toBe(false);
		expect(result.error).toBe("insufficient credit");
	});
});

describe("parseKieCallback", () => {
	it("finishes a job straight from the callback body", () => {
		const settled = parseKieCallback(
			JSON.stringify({
				code: 200,
				data: {
					taskId: "task-6",
					state: "success",
					creditsConsumed: 7,
					resultJson: JSON.stringify({ resultUrls: ["https://cdn.kie/i.jpg"] }),
				},
			}),
		);

		expect(settled.taskId).toBe("task-6");
		const snapshot = kieSnapshot(settled, "google/nano-banana");
		expect(snapshot.status).toBe("succeeded");
		expect(snapshot.result?.outputs[0]).toEqual({
			url: "https://cdn.kie/i.jpg",
			mimeType: "image/jpeg",
		});
		expect(snapshot.result?.creditsUsed).toBe(7);
	});

	it("accepts an unwrapped record and rejects one with no taskId", () => {
		expect(parseKieCallback({ taskId: "task-7", state: "generating" }).status).toBe(
			"pending",
		);
		expect(() => parseKieCallback({ state: "success" })).toThrow(/taskId/);
	});
});

describe("routing through kie", () => {
	afterEach(() => {
		mock.restore();
	});

	it("serves a model with no vendor key, ahead of the Brotu fallback", async () => {
		const fetchMock = mock((input: string | URL) => {
			expect(String(input)).toContain("api.kie.ai");
			return ok({ taskId: "task-8" });
		});
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		const { data, error } = await brotu({
			apiKey: "brotu_sk_test",
			providers: { kie: { apiKey: "kie_test" } },
		}).video.submit({ model: "kling/v2-6", prompt: "x" });

		expect(error).toBeNull();
		expect(data?.provider).toBe("kie");
		expect(fetchMock).toHaveBeenCalled();
	});

	it("leaves a model alone when its own vendor key is configured", async () => {
		const fetchMock = mock(() =>
			Promise.resolve(new Response("should not hit kie", { status: 500 })),
		);
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		const { data } = await brotu({
			apiKey: "brotu_sk_test",
			providers: { kie: { apiKey: "kie_test" }, kling: { apiKey: "k" } },
		}).video.submit({ model: "kling/v2-6", prompt: "x" });

		expect(data?.provider ?? "kling").toBe("kling");
	});
});
