import { afterEach, describe, expect, it, mock } from "bun:test";
import { brotuClient } from "../client";
import type { Job } from "../lib/jobs";
import { deliverWebhook, resolveWebhook } from "../lib/webhook";

const settledJob = (id = "inline-1"): Job => ({
	id,
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
		processingTimeMs: 12,
	},
});

describe("resolveWebhook", () => {
	it("accepts a URL string", () => {
		expect(resolveWebhook("https://hooks.example/brotu")).toEqual({
			url: "https://hooks.example/brotu",
		});
	});

	it("accepts http for local development", () => {
		expect(resolveWebhook("http://localhost:3000/hook")?.url).toBe(
			"http://localhost:3000/hook",
		);
	});

	it("rejects a non-http URL", () => {
		expect(resolveWebhook("ftp://hooks.example/brotu")).toBeUndefined();
		expect(resolveWebhook("not-a-url")).toBeUndefined();
	});

	it("keeps secret and extra headers", () => {
		expect(
			resolveWebhook({
				url: "https://hooks.example/brotu",
				secret: "s3cret",
				headers: { "x-env": "test" },
			}),
		).toEqual({
			url: "https://hooks.example/brotu",
			secret: "s3cret",
			headers: { "x-env": "test" },
		});
	});
});

describe("deliverWebhook", () => {
	afterEach(() => {
		mock.restore();
	});

	it("POSTs the payload with event and secret headers", async () => {
		const fetchMock = mock(() => Promise.resolve(new Response(null, { status: 204 })));
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		await deliverWebhook(
			{ url: "https://hooks.example/brotu", secret: "s3cret" },
			{
				event: "generation.succeeded",
				jobId: "task-1",
				provider: "kling",
				model: "kling/v2-6",
				kind: "video",
				outputs: [{ url: "https://x/v.mp4", mimeType: "video/mp4" }],
				completedAt: "1970-01-01T00:00:00.000Z",
			},
		);

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = fetchMock.mock.calls[0] as unknown as [
			string,
			RequestInit,
		];
		expect(url).toBe("https://hooks.example/brotu");
		expect(init.method).toBe("POST");
		const headers = new Headers(init.headers);
		expect(headers.get("content-type")).toBe("application/json");
		expect(headers.get("x-brotu-event")).toBe("generation.succeeded");
		expect(headers.get("x-brotu-webhook-secret")).toBe("s3cret");
		const body = JSON.parse(String(init.body)) as { jobId: string };
		expect(body.jobId).toBe("task-1");
	});

	it("swallows a down endpoint", async () => {
		globalThis.fetch = mock(() => Promise.reject(new Error("ECONNREFUSED"))) as unknown as typeof fetch;

		await expect(
			deliverWebhook(
				{ url: "https://hooks.example/down" },
				{
					event: "generation.failed",
					completedAt: "1970-01-01T00:00:00.000Z",
				},
			),
		).resolves.toBeUndefined();
	});
});

describe("client webhook", () => {
	afterEach(() => {
		mock.restore();
	});

	it("registers, reads back, and clears", () => {
		const ai = brotuClient({
			providers: { kling: { apiKey: "k" } },
			webhook: "https://hooks.example/brotu",
		});

		expect(ai.webhook.get()?.url).toBe("https://hooks.example/brotu");
		ai.webhook.set({ url: "https://hooks.example/other", secret: "s" });
		expect(ai.webhook.get()).toEqual({
			url: "https://hooks.example/other",
			secret: "s",
		});
		ai.webhook.clear();
		expect(ai.webhook.get()).toBeUndefined();
	});

	it("POSTs once when a settled job is polled", async () => {
		const fetchMock = mock(() => Promise.resolve(new Response(null, { status: 204 })));
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		const ai = brotuClient({
			providers: { kling: { apiKey: "k" } },
			webhook: "https://hooks.example/brotu",
		});

		const job = settledJob();
		await ai.jobs.poll(job);
		await ai.jobs.poll(job);

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const body = JSON.parse(
			String(
				(fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body,
			),
		) as { event: string; jobId: string; outputs: { url: string }[] };
		expect(body.event).toBe("generation.succeeded");
		expect(body.jobId).toBe("inline-1");
		expect(body.outputs[0]?.url).toBe("https://x/v.mp4");
	});

	it("lets a per-request webhook win over the client one", async () => {
		const fetchMock = mock(() => Promise.resolve(new Response(null, { status: 204 })));
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		const ai = brotuClient({
			providers: { kling: { apiKey: "k" } },
			webhook: "https://hooks.example/client",
		});

		await ai.jobs.poll({
			...settledJob("inline-2"),
			params: { prompt: "x", webhook: "https://hooks.example/request" },
		});

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe(
			"https://hooks.example/request",
		);
	});

	it("does not fire when nothing is registered", async () => {
		const fetchMock = mock(() => Promise.resolve(new Response(null, { status: 204 })));
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		const ai = brotuClient({ providers: { kling: { apiKey: "k" } } });
		await ai.jobs.poll(settledJob());

		expect(fetchMock).not.toHaveBeenCalled();
	});
});
