import { describe, expect, it } from "bun:test";
import { QwenAdapter } from "../adapters/qwen.adapter";
import {
	QWEN_AUDIO_MODELS,
	QWEN_CATALOG,
	QWEN_IMAGE_MODELS,
	QWEN_TEXT_MODELS,
	QWEN_VIDEO_MODELS,
	videoPathFor,
} from "../providers/qwen.models";

const adapter = new QwenAdapter({ apiKey: "sk-ws-test" });

function body(model: string, params: Record<string, unknown>) {
	const inner = adapter as unknown as {
		videoBody: (
			id: string,
			binding: unknown,
			params: unknown,
		) => Record<string, unknown>;
	};
	return inner.videoBody(model, QWEN_VIDEO_MODELS[model], params) as {
		input: Record<string, unknown>;
		parameters: Record<string, unknown>;
		model: string;
	};
}

describe("the four input shapes at one endpoint", () => {
	it("wraps wan2.7 references in media objects", () => {
		const built = body("wan2.7-i2v", {
			prompt: "a cat",
			imageUrl: "https://x/a.png",
		});
		expect(built.input.media).toEqual([
			{ type: "first_frame", url: "https://x/a.png" },
		]);
		expect(built.input.img_url).toBeUndefined();
	});

	it("sends wan2.6 the flat img_url string instead", () => {
		const built = body("wan2.6-i2v", {
			prompt: "a cat",
			imageUrl: "https://x/a.png",
		});
		expect(built.input.img_url).toBe("https://x/a.png");
		expect(built.input.media).toBeUndefined();
	});

	it("gives the keyframe model its own two fields", () => {
		const built = body("wan2.2-kf2v-flash", {
			prompt: "a cat",
			referenceImages: ["https://x/a.png", "https://x/b.png"],
		});
		expect(built.input.first_frame_url).toBe("https://x/a.png");
		expect(built.input.last_frame_url).toBe("https://x/b.png");
	});

	it("puts the keyframe model on a different path than every other capability", () => {
		expect(videoPathFor(QWEN_VIDEO_MODELS["wan2.2-kf2v-flash"])).toContain(
			"/image2video/",
		);
		expect(videoPathFor(QWEN_VIDEO_MODELS["wan2.7-t2v"])).toContain(
			"/video-generation/",
		);
	});

	it("sends wan2.6-r2v a flat array of reference urls", () => {
		const built = body("wan2.6-r2v", {
			prompt: "a cat",
			imageUrls: ["https://x/a.png", "https://x/b.png"],
		});
		expect(built.input.reference_urls).toEqual([
			"https://x/a.png",
			"https://x/b.png",
		]);
	});

	it("refuses a keyframe request with only one frame", () => {
		expect(() =>
			body("wan2.2-kf2v-flash", {
				prompt: "a cat",
				referenceImages: ["https://x/a.png"],
			}),
		).toThrow(/first and a last frame/);
	});
});

describe("defaults that would cost money", () => {
	it("pins resolution, because a defaulted task came back 1080p", () => {
		expect(body("wan2.7-t2v", { prompt: "a" }).parameters.resolution).toBe(
			"720P",
		);
	});

	it("turns prompt_extend off, which the API defaults on", () => {
		expect(body("wan2.7-t2v", { prompt: "a" }).parameters.prompt_extend).toBe(
			false,
		);
	});

	it("switches off the watermark only where the provider defaults it on", () => {
		expect(
			body("happyhorse-1.1-t2v", { prompt: "a" }).parameters.watermark,
		).toBe(false);
		expect(
			body("wan2.7-t2v", { prompt: "a" }).parameters.watermark,
		).toBeUndefined();
	});
});

describe("sizing differs by family", () => {
	it("uses resolution and ratio on wan2.7", () => {
		const built = body("wan2.7-t2v", { prompt: "a", aspectRatio: "9:16" });
		expect(built.parameters.ratio).toBe("9:16");
		expect(built.parameters.size).toBeUndefined();
	});

	it("uses size on wan2.6 and never sends resolution", () => {
		const built = body("wan2.6-t2v", { prompt: "a", resolution: "1280*720" });
		expect(built.parameters.size).toBe("1280*720");
		expect(built.parameters.resolution).toBeUndefined();
	});
});

describe("the async header is gated, not global", () => {
	it("marks every wired image model as answering inline", () => {
		// Sending the async header to a sync-only model returns 429, which reads as
		// rate limiting and never clears on retry.
		for (const binding of Object.values(QWEN_IMAGE_MODELS)) {
			expect(binding.sync).toBe(true);
		}
	});
});

describe("result shapes", () => {
	function snapshot(payload: unknown) {
		const inner = adapter as unknown as {
			snapshot: (
				payload: unknown,
				job: unknown,
			) => {
				status: string;
				error?: string;
				result?: { outputs: Array<{ url: string }> };
			};
		};
		return inner.snapshot(payload, { kind: "video", model: "wan2.7-t2v" });
	}

	it("reads a video from output.video_url", () => {
		const result = snapshot({
			request_id: "r",
			output: { task_status: "SUCCEEDED", video_url: "https://x/v.mp4" },
		});
		expect(result.result?.outputs[0]?.url).toBe("https://x/v.mp4");
	});

	it("reads an image from output.choices, the shape qwen uses", () => {
		const result = snapshot({
			request_id: "r",
			output: {
				task_status: "SUCCEEDED",
				choices: [{ message: { content: [{ image: "https://x/i.png" }] } }],
			},
		});
		expect(result.result?.outputs[0]?.url).toBe("https://x/i.png");
	});

	it("reads the legacy output.results shape too", () => {
		const result = snapshot({
			request_id: "r",
			output: {
				task_status: "SUCCEEDED",
				results: [{ url: "https://x/legacy.png" }],
			},
		});
		expect(result.result?.outputs[0]?.url).toBe("https://x/legacy.png");
	});

	it("treats both spellings of cancelled as terminal", () => {
		expect(
			snapshot({ request_id: "r", output: { task_status: "CANCELED" } }).status,
		).toBe("failed");
		expect(
			snapshot({ request_id: "r", output: { task_status: "CANCELLED" } })
				.status,
		).toBe("failed");
	});

	it("treats an unknown task as terminal, since the id has expired", () => {
		expect(
			snapshot({ request_id: "r", output: { task_status: "UNKNOWN" } }).status,
		).toBe("failed");
	});

	it("surfaces the failure code alongside the message", () => {
		// The only place a rejected body reports itself is the polled task.
		const result = snapshot({
			request_id: "r",
			output: {
				task_status: "FAILED",
				code: "InvalidParameter",
				message: "Field required: input.messages",
			},
		});
		expect(result.error).toBe(
			"InvalidParameter: Field required: input.messages",
		);
	});
});

describe("catalog", () => {
	it("covers every model in all four categories", () => {
		expect(QWEN_CATALOG.length).toBe(
			Object.keys(QWEN_VIDEO_MODELS).length +
				Object.keys(QWEN_IMAGE_MODELS).length +
				Object.keys(QWEN_AUDIO_MODELS).length +
				Object.keys(QWEN_TEXT_MODELS).length,
		);
		expect(QWEN_CATALOG.every((m) => m.provider === "qwen")).toBe(true);
	});

	it("reports happyhorse's real minimum of 3 seconds, not 2", () => {
		const model = QWEN_CATALOG.find((m) => m.id === "happyhorse-1.1-t2v");
		expect(model?.minDuration).toBe(3);
	});

	it("brings the Wan and HappyHorse families in natively", () => {
		const ids = QWEN_CATALOG.map((m) => m.id);
		expect(ids).toContain("wan2.7-t2v");
		expect(ids).toContain("happyhorse-1.1-i2v");
	});
});
