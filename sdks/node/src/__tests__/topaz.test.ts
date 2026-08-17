import { describe, expect, it } from "bun:test";
import { TopazAdapter } from "../adapters/topaz.adapter";
import { isPendingJob, runInSubmitMode } from "../lib/jobs";
import { TOPAZ_CATALOG, TOPAZ_MODELS } from "../providers/topaz.models";

const adapter = new TopazAdapter({ apiKey: "tz-test" });

function body(model: string, params: Record<string, unknown>) {
	const inner = adapter as unknown as {
		binding: (id: string) => [string, unknown];
		requestBody: (
			binding: unknown,
			params: unknown,
			sourceUrl: string,
		) => Record<string, unknown>;
	};
	const [, binding] = inner.binding(model);
	return inner.requestBody(binding, { model, ...params }, String(params.videoUrl));
}

describe("catalog", () => {
	it("ships every documented video and image model under topaz", () => {
		expect(TOPAZ_MODELS["aion-1"]?.kind).toBe("interpolation");
		expect(TOPAZ_MODELS["prob-4"]?.kind).toBe("upscale");
		expect(TOPAZ_MODELS["slp-2.6"]?.vendorModel).toBe("slp-2.6");
		expect(TOPAZ_MODELS["wonder-3.5"]?.vendorModel).toBe("Wonder 3.5");
		expect(TOPAZ_MODELS["Wonder 3.5"]?.vendorModel).toBe("Wonder 3.5");
		expect(TOPAZ_CATALOG.every((model) => model.provider === "topaz")).toBe(
			true,
		);
		expect(TOPAZ_CATALOG.some((model) => model.category === "image")).toBe(
			true,
		);
		expect(TOPAZ_CATALOG.some((model) => model.category === "video")).toBe(
			true,
		);
		expect(adapter.getAvailableModels().length).toBe(TOPAZ_CATALOG.length);
	});
});

describe("the express body", () => {
	it("sends aion-1 and only asks for the container on the source", () => {
		const built = body("aion-1", {
			videoUrl: "https://cdn.example/in.mp4",
		});
		expect(built.source).toEqual({ container: "mp4" });
		expect(built.filters).toEqual([
			{ model: "aion-1", slowmo: 1, fps: 30 },
		]);
		expect(
			(built.output as { resolution: { width: number; height: number } })
				.resolution,
		).toEqual({ width: 1920, height: 1080 });
	});

	it("reads mov/mkv from the URL and named resolutions", () => {
		const mov = body("aion-1", {
			videoUrl: "https://cdn.example/clip.mov?sig=1",
			resolution: "720p",
		});
		expect((mov.source as { container: string }).container).toBe("mov");
		expect(
			(mov.output as { resolution: { width: number } }).resolution.width,
		).toBe(1280);

		const fourK = body("aion-1", {
			videoUrl: "https://cdn.example/in.mkv",
			resolution: "4k",
		});
		expect((fourK.source as { container: string }).container).toBe("mkv");
		expect(
			(fourK.output as { resolution: { height: number } }).resolution.height,
		).toBe(2160);
	});

	it("accepts an explicit pixel pair", () => {
		const built = body("aion-1", {
			videoUrl: "https://cdn.example/in.mp4",
			resolution: "1280x720",
		});
		expect(
			(built.output as { resolution: { width: number; height: number } })
				.resolution,
		).toEqual({ width: 1280, height: 720 });
	});

	it("sends Proteus as an upscale filter, not interpolation knobs", () => {
		const built = body("prob-4", {
			videoUrl: "https://cdn.example/in.mp4",
			resolution: "4k",
		});
		expect(built.filters).toEqual([{ auto: "Auto", model: "prob-4" }]);
		expect(
			(built.output as { resolution: { width: number } }).resolution.width,
		).toBe(3840);
	});

	it("puts interpolation knobs on the filter, not the top-level body", () => {
		const built = body("aion-1", {
			videoUrl: "https://cdn.example/in.mp4",
			providerOptions: {
				topaz: { slowmo: 4, fps: 60, duplicate: true },
			},
		});
		expect(built.filters).toEqual([
			{ model: "aion-1", slowmo: 4, fps: 60, duplicate: true },
		]);
		expect(built.slowmo).toBeUndefined();
		expect((built.output as { frameRate: number }).frameRate).toBe(60);
	});

	it("refuses a slowmo or fps the API will reject", () => {
		expect(() =>
			body("aion-1", {
				videoUrl: "https://cdn.example/in.mp4",
				providerOptions: { topaz: { slowmo: 32 } },
			}),
		).toThrow(/slowmo is 1–16/);
		expect(() =>
			body("aion-1", {
				videoUrl: "https://cdn.example/in.mp4",
				providerOptions: { topaz: { fps: 10 } },
			}),
		).toThrow(/fps is 15–240/);
	});

	it("needs a source video", async () => {
		const result = await adapter.generateVideo({
			model: "aion-1",
			prompt: "",
		});
		expect(result.success).toBe(false);
		expect(result.error).toMatch(/videoUrl/);
	});

	it("refuses to run an image model on the video surface", async () => {
		const result = await adapter.generateVideo({
			model: "standard-v2",
			prompt: "",
			videoUrl: "https://cdn.example/in.mp4",
		});
		expect(result.success).toBe(false);
		expect(result.error).toMatch(/image model/);
	});
});

describe("image enhance", () => {
	it("posts the vendor's spaced name and the source URL", () => {
		const inner = adapter as unknown as {
			binding: (id: string) => [string, unknown];
			imageBody: (
				binding: unknown,
				params: unknown,
				sourceUrl: string,
			) => Record<string, string>;
		};
		const [, binding] = inner.binding("wonder-3.5");
		const fields = inner.imageBody(
			binding,
			{ model: "wonder-3.5", resolution: "2K" },
			"https://cdn.example/in.jpg",
		);
		expect(fields.model).toBe("Wonder 3.5");
		expect(fields.source_url).toBe("https://cdn.example/in.jpg");
		expect(fields.output_width).toBe("2048");
	});

	it("needs a source image", async () => {
		const result = await adapter.generateImage({
			model: "standard-v2",
			prompt: "",
		});
		expect(result.success).toBe(false);
		expect(result.error).toMatch(/source image/);
	});
});

describe("submit and poll", () => {
	it("uploads then throws PendingJob in submit mode", async () => {
		const calls: Array<{ url: string; method: string }> = [];
		const previous = globalThis.fetch;
		globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
			const url = String(input);
			const method = init?.method ?? "GET";
			calls.push({ url, method });
			if (url.includes("cdn.example")) {
				return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
			}
			if (url.endsWith("/video/express")) {
				return new Response(
					JSON.stringify({
						requestId: "req-1",
						uploadUrls: ["https://upload.example/part"],
					}),
					{ status: 200 },
				);
			}
			if (url.includes("upload.example")) {
				return new Response(null, { status: 200 });
			}
			return new Response("not mocked", { status: 500 });
		}) as typeof fetch;

		try {
			await runInSubmitMode(() =>
				adapter.generateVideo({
					model: "aion-1",
					prompt: "",
					videoUrl: "https://cdn.example/in.mp4",
				}),
			);
			throw new Error("expected PendingJob");
		} catch (error) {
			expect(isPendingJob(error)).toBe(true);
			if (isPendingJob(error)) {
				expect(error.taskId).toBe("req-1");
				expect(error.pollEndpoint).toBe("/video/req-1/status");
			}
		} finally {
			globalThis.fetch = previous;
		}

		expect(calls.map((call) => call.method)).toEqual(["GET", "POST", "PUT"]);
		expect(calls[1]?.url).toContain("/video/express");
	});

	it("reads the signed URL off a complete status", () => {
		const inner = adapter as unknown as {
			outputsFrom: (
				payload: unknown,
				job: { id: string },
			) => Array<{ url: string; expiresAt?: string; raw?: unknown }>;
		};
		const [output] = inner.outputsFrom(
			{
				status: "complete",
				download: {
					url: "https://cdn.topaz/out.mp4",
					expiresAt: Date.now() + 86_400_000,
				},
			},
			{ id: "req-1" },
		);
		expect(output?.url).toBe("https://cdn.topaz/out.mp4");
		expect(output?.expiresAt).toBeTruthy();
		expect(Date.parse(output?.expiresAt ?? "")).toBeGreaterThan(Date.now());
	});
});
