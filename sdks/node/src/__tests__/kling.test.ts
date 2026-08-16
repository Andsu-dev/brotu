import { describe, expect, it } from "bun:test";
import { KlingAdapter } from "../adapters/kling.adapter";
import { brotuClient } from "../client";
import {
	avatar,
	imageOmni,
	KLING_AUDIO_CATALOG,
	KLING_VOICES,
	motionControl,
	omniVideo,
	outpainting,
} from "../providers/kling.models";

describe("motion control", () => {
	const input = {
		imageUrl: "https://x/face.png",
		videoUrl: "https://x/dance.mp4",
		characterOrientation: "video" as const,
	};

	it("posts to the path-versioned route with the model in it", () => {
		expect(motionControl.path({ ...input, model: "kling-3.0" })).toBe(
			"/motion-control/kling-3.0",
		);
	});

	it("uses this endpoint's own content vocabulary, not first_frame", () => {
		const body = motionControl.body(input) as {
			contents: Array<{ type: string }>;
		};
		expect(body.contents.map((c) => c.type)).toEqual(["image", "video"]);
	});

	it("always sends character_orientation, which the API requires", () => {
		const body = motionControl.body(input) as {
			settings: Record<string, unknown>;
		};
		expect(body.settings.character_orientation).toBe("video");
	});

	it("has no duration: output length comes from the reference video", () => {
		const body = motionControl.body(input) as {
			settings: Record<string, unknown>;
		};
		expect(body.settings.duration).toBeUndefined();
		expect(body.settings.aspect_ratio).toBeUndefined();
	});
});

describe("omni video", () => {
	it("cites elements by their task-local id", () => {
		const body = omniVideo.body({
			prompt: "@hero walks in",
			elements: [{ elementId: "el_1", id: "hero" }],
		}) as { contents: Array<Record<string, unknown>> };

		expect(body.contents[1]).toEqual({
			type: "element",
			element_id: "el_1",
			id: "hero",
		});
	});

	it("passes a base video through as an editing source", () => {
		const body = omniVideo.body({
			prompt: "make it night",
			references: [{ type: "base_video", url: "https://x/v.mp4" }],
		}) as { contents: Array<{ type: string }> };

		expect(body.contents.map((c) => c.type)).toEqual(["prompt", "base_video"]);
	});
});

describe("avatar", () => {
	it("refuses both an audio id and a sound file", () => {
		expect(() =>
			avatar.body({
				imageUrl: "https://x/p.png",
				audioId: "a1",
				soundFileUrl: "https://x/a.mp3",
			}),
		).toThrow(/exactly one/);
	});

	it("refuses neither", () => {
		expect(() => avatar.body({ imageUrl: "https://x/p.png" })).toThrow(
			/exactly one/,
		);
	});

	it("reads its results from task_result.videos, not outputs", () => {
		expect(avatar.results).toBe("videos");
		expect(avatar.api).toBe("v1");
	});
});

describe("outpainting", () => {
	const base = {
		imageUrl: "https://x/i.png",
		up: 0,
		down: 0,
		left: 0,
		right: 0,
	};

	it("sends all four ratios even when they are zero", () => {
		const body = outpainting.body({ ...base, up: 0.5 });
		expect(body.up_expansion_ratio).toBe(0.5);
		expect(body.down_expansion_ratio).toBe(0);
		expect(body.left_expansion_ratio).toBe(0);
		expect(body.right_expansion_ratio).toBe(0);
	});

	it("rejects a ratio outside the documented range", () => {
		expect(() => outpainting.body({ ...base, up: 3 })).toThrow(
			/between 0 and 2/,
		);
	});
});

describe("image omni", () => {
	it("caps references and elements at ten combined", () => {
		expect(() =>
			imageOmni.body({
				prompt: "x",
				imageUrls: Array.from({ length: 8 }, (_, i) => `https://x/${i}.png`),
				elementIds: ["a", "b", "c"],
			}),
		).toThrow(/at most 10 references/);
	});

	it("selects the model through model_name, not the path", () => {
		expect(imageOmni.path({ prompt: "x" })).toBe("/v1/images/omni-image");
		expect(
			imageOmni.body({ prompt: "x", model: "kling-v3-omni" }).model_name,
		).toBe("kling-v3-omni");
	});
});

describe("the kling namespace", () => {
	it("is absent when no kling key is configured", () => {
		const ai = brotuClient({
			apiKey: "brotu_sk_test",
			providers: { byteplus: { apiKey: "ark-x" } },
		});
		expect(ai.kling).toBeUndefined();
	});

	it("is present when one is", () => {
		const ai = brotuClient({
			apiKey: "brotu_sk_test",
			providers: { kling: { apiKey: "k" } },
		});
		expect(typeof ai.kling?.motionControl).toBe("function");
		expect(typeof ai.kling?.avatar).toBe("function");
	});
});

describe("kling speech", () => {
	const adapter = new KlingAdapter({ apiKey: "k" });

	it("refuses without a voice, naming presets rather than a bare error", async () => {
		const result = await adapter.generateAudio({ prompt: "hello" });
		expect(result.success).toBe(false);
		expect(result.error).toMatch(/Presets: genshin_vindi2/);
	});

	it("ships only voice ids verified against the live API", () => {
		// An unknown id answers "Voice id not found", so this list was measured.
		expect(KLING_VOICES).toContain("uk_boy1");
		expect(KLING_VOICES).toContain("cartoon-girl-01");
		expect(KLING_VOICES.length).toBe(20);
	});

	it("puts speech in the catalog as audio, alongside video and image", () => {
		expect(KLING_AUDIO_CATALOG[0]?.category).toBe("audio");
		expect(KLING_AUDIO_CATALOG[0]?.creditUnit).toBe("character");
		expect(KLING_AUDIO_CATALOG[0]?.provider).toBe("kling");
	});
});
