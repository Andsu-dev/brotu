import { describe, expect, it } from "bun:test";
import { GoogleAdapter } from "../adapters/google.adapter";
import { OpenAIAdapter } from "../adapters/openai.adapter";
import { brotu } from "../client";
import {
	GOOGLE_AUDIO_MODELS,
	GOOGLE_TEXT_MODELS,
	GOOGLE_TTS_VOICES,
	GOOGLE_VIDEO_MODELS,
} from "../providers/google.models";
import {
	OPENAI_IMAGE_MODELS,
	OPENAI_TEXT_MODELS,
} from "../providers/openai.models";

const openai = new OpenAIAdapter({ apiKey: "sk-test" });
const google = new GoogleAdapter({ apiKey: "goog-test" });

function openaiBody(model: string, params: Record<string, unknown>) {
	const inner = openai as unknown as {
		buildBody: (id: string, b: unknown, p: unknown) => Record<string, unknown>;
	};
	return inner.buildBody(model, OPENAI_IMAGE_MODELS[model], params);
}

function veoBody(_model: string, params: Record<string, unknown>) {
	const inner = google as unknown as {
		veoBody: (p: unknown) => Record<string, unknown>;
	};
	return inner.veoBody(params) as {
		instances: Array<Record<string, unknown>>;
		parameters: Record<string, unknown>;
	};
}

describe("openai images", () => {
	it("always sends the model, since omitting it defaulted to a dead one", () => {
		expect(openaiBody("gpt-image-2", { prompt: "a cat" }).model).toBe(
			"gpt-image-2",
		);
	});

	it("pins quality, which the API would otherwise pick for you", () => {
		// auto can land on high, which is over 30x the low tier.
		expect(openaiBody("gpt-image-2", { prompt: "a cat" }).quality).toBe(
			"medium",
		);
	});

	it("rejects a size whose edges are not multiples of 16", () => {
		expect(() =>
			openaiBody("gpt-image-2", { prompt: "a cat", resolution: "1000x1000" }),
		).toThrow(/divisible by 16/);
	});

	it("rejects a size the older model does not offer", () => {
		expect(() =>
			openaiBody("gpt-image-1.5", { prompt: "a cat", resolution: "3840x2160" }),
		).toThrow(/accepts/);
	});

	it("refuses video outright rather than pretending", () => {
		expect(() => openai.generateVideo({ prompt: "x" })).toThrow(
			/shut down on 24 September 2026/,
		);
	});

	it("prices by quality tier, and says how wide the spread is", async () => {
		const low = await openai.estimateCost("image", {
			model: "gpt-image-2",
			prompt: "x",
			quality: "low",
		});
		const high = await openai.estimateCost("image", {
			model: "gpt-image-2",
			prompt: "x",
			quality: "high",
		});
		expect(low.usd).toBe(0.006);
		expect(high.usd).toBe(0.211);
		expect(high.note).toMatch(/30x/);
	});
});

describe("veo", () => {
	it("sends durationSeconds as a string, not a number", () => {
		const body = veoBody("veo-3.1-generate-preview", {
			prompt: "a cat",
			duration: 6,
		});
		expect(body.parameters.durationSeconds).toBe("6");
		expect(typeof body.parameters.durationSeconds).toBe("string");
	});

	it("narrows personGeneration when an image drives the video", () => {
		// allow_all is valid for text-to-video and rejected for image-to-video.
		const text = veoBody("veo-3.1-generate-preview", { prompt: "a cat" });
		expect(text.parameters.personGeneration).toBe("allow_all");

		const image = veoBody("veo-3.1-generate-preview", {
			prompt: "a cat",
			imageUrl: "data:image/png;base64,AAA",
		});
		expect(image.parameters.personGeneration).toBe("allow_adult");
	});

	it("forces the longest duration above 720p", () => {
		const body = veoBody("veo-3.1-generate-preview", {
			prompt: "a cat",
			resolution: "4k",
		});
		expect(body.parameters.durationSeconds).toBe("8");
	});

	it("refuses 4k on the lite model", async () => {
		const result = await google.generateVideo({
			model: "veo-3.1-lite-generate-preview",
			prompt: "x",
			resolution: "4k",
		});
		expect(result.success).toBe(false);
		expect(result.error).toMatch(/supports 720p, 1080p/);
	});

	it("refuses reference images on the model that lacks them", async () => {
		const result = await google.generateVideo({
			model: "veo-3.1-lite-generate-preview",
			prompt: "x",
			imageUrls: ["data:image/png;base64,AAA"],
		});
		expect(result.error).toMatch(/does not take reference images/);
	});

	it("prices per second from the catalog", async () => {
		const ai = brotu({ apiKey: "brotu_sk_test", providers: { google: { apiKey: "g" } } });
		const { data } = await ai.estimateCost("video", {
			model: "veo-3.1-generate-preview",
			prompt: "x",
			duration: 8,
		});
		expect(data?.unit).toBe("second");
		expect(data?.units).toBe(8);
		expect(data?.usd).toBe(3.2);
	});
});

describe("gemini omni", () => {
	function omniBody(params: Record<string, unknown>) {
		const inner = google as unknown as {
			omniBody: (id: string, p: unknown) => Record<string, unknown>;
		};
		return inner.omniBody("gemini-omni-flash-preview", params) as {
			input: Array<{ type: string }>;
			response_format: Record<string, unknown>;
			generation_config: { video_config: { task: string } };
			previous_interaction_id?: string;
		};
	}

	it("goes through the Interactions API, not Veo's predict endpoint", () => {
		expect(GOOGLE_VIDEO_MODELS["gemini-omni-flash-preview"].api).toBe(
			"interactions",
		);
		expect(GOOGLE_VIDEO_MODELS["veo-3.1-generate-preview"].api).toBe("predict");
	});

	it("infers the task from what came with the prompt", () => {
		expect(
			omniBody({ prompt: "a cat" }).generation_config.video_config.task,
		).toBe("text_to_video");
		expect(
			omniBody({ prompt: "a cat", imageUrl: "data:image/png;base64,AA" })
				.generation_config.video_config.task,
		).toBe("image_to_video");
		expect(
			omniBody({ prompt: "a cat", videoUrl: "data:video/mp4;base64,AA" })
				.generation_config.video_config.task,
		).toBe("edit");
		expect(
			omniBody({ prompt: "a cat", imageUrls: ["data:image/png;base64,AA"] })
				.generation_config.video_config.task,
		).toBe("reference_to_video");
	});

	it("carries the previous interaction so a refinement edits instead of restarting", () => {
		const body = omniBody({
			prompt: "make it night",
			previousInteractionId: "i_1",
		});
		expect(body.previous_interaction_id).toBe("i_1");
	});

	it("asks for a uri, since a base64 video over 4MB cannot come back inline", () => {
		expect(omniBody({ prompt: "a cat" }).response_format.delivery).toBe("uri");
	});

	it("has no published rate, so it reports units without inventing a price", async () => {
		const ai = brotu({ apiKey: "brotu_sk_test", providers: { google: { apiKey: "g" } } });
		const { data } = await ai.estimateCost("video", {
			model: "gemini-omni-flash-preview",
			prompt: "x",
		});
		expect(data?.usd).toBeNull();
		expect(data?.note).toMatch(/No verified rate/);
	});

	it("exposes the namespace only when a google key is configured", () => {
		expect(
			brotu({ apiKey: "brotu_sk_test", providers: { google: { apiKey: "g" } } }).google,
		).toBeDefined();
		expect(
			brotu({ apiKey: "brotu_sk_test", providers: { kling: { apiKey: "k" } } }).google,
		).toBeUndefined();
	});
});

describe("openai text", () => {
	function textBody(params: Record<string, unknown>) {
		const inner = openai as unknown as {
			textBody: (p: unknown) => Record<string, unknown>;
		};
		return inner.textBody(params) as {
			model: string;
			input: Array<{ role: string; content: unknown }>;
			max_output_tokens?: number;
			temperature?: number;
		};
	}

	it("lists the current 5.6 ladder and nothing retired", () => {
		expect(Object.keys(OPENAI_TEXT_MODELS).sort()).toEqual([
			"gpt-5.6-luna",
			"gpt-5.6-sol",
			"gpt-5.6-terra",
		]);
	});

	it("sends the Responses API envelope, not chat completions", () => {
		const body = textBody({
			model: "gpt-5.6-luna",
			prompt: "hello",
			systemPrompt: "be brief",
			maxTokens: 64,
		});
		expect(body.model).toBe("gpt-5.6-luna");
		expect(body.max_output_tokens).toBe(64);
		expect(body.input[0]).toEqual({ role: "system", content: "be brief" });
		expect(body.input[1]).toEqual({ role: "user", content: "hello" });
	});

	it("attaches reference images as input_image parts", () => {
		const body = textBody({
			model: "gpt-5.6-sol",
			prompt: "what is this",
			referenceImages: ["https://x/a.png"],
		});
		expect(body.input[0]?.content).toEqual([
			{ type: "input_text", text: "what is this" },
			{ type: "input_image", image_url: "https://x/a.png" },
		]);
	});

	it("refuses an image model on the text path", async () => {
		const result = await openai.generateText({
			model: "gpt-image-2",
			prompt: "x",
		});
		expect(result.success).toBe(false);
		expect(result.error).toMatch(/not an OpenAI text model/);
	});
});

describe("gemini text", () => {
	function textBody(params: Record<string, unknown>) {
		const inner = google as unknown as {
			textBody: (id: string, p: unknown) => Record<string, unknown>;
		};
		return inner.textBody("gemini-3.7-flash", params) as {
			model: string;
			input: Array<{ type: string; text?: string }>;
			instructions?: string;
			generation_config: Record<string, unknown>;
		};
	}

	it("lists the current Gemini text ladder", () => {
		expect(GOOGLE_TEXT_MODELS["gemini-3.7-flash"]).toBeDefined();
		expect(GOOGLE_TEXT_MODELS["gemini-3.1-pro-preview"]).toBeDefined();
		expect("gemini-2.0-flash" in GOOGLE_TEXT_MODELS).toBe(false);
	});

	it("goes through Interactions, with system text as instructions", () => {
		const body = textBody({
			prompt: "hello",
			systemPrompt: "be brief",
			maxTokens: 32,
			temperature: 0.2,
		});
		expect(body.model).toBe("gemini-3.7-flash");
		expect(body.instructions).toBe("be brief");
		expect(body.generation_config.max_output_tokens).toBe(32);
		expect(body.generation_config.temperature).toBe(0.2);
		expect(body.input[0]).toEqual({ type: "text", text: "hello" });
	});

	it("refuses a Veo id on the text path", async () => {
		const result = await google.generateText({
			model: "veo-3.1-generate-preview",
			prompt: "x",
		});
		expect(result.success).toBe(false);
		expect(result.error).toMatch(/not a Gemini text model/);
	});
});

describe("gemini tts", () => {
	function speechBody(voice = "Kore") {
		const inner = google as unknown as {
			speechBody: (
				id: string,
				p: unknown,
				voice: string,
			) => Record<string, unknown>;
		};
		return inner.speechBody(
			"gemini-3.1-flash-tts-preview",
			{ prompt: "hello" },
			voice,
		) as {
			model: string;
			input: string;
			response_format: { type: string };
			generation_config: { speech_config: Array<{ voice: string }> };
		};
	}

	it("lists the three current TTS models", () => {
		expect(Object.keys(GOOGLE_AUDIO_MODELS).sort()).toEqual([
			"gemini-2.5-flash-preview-tts",
			"gemini-2.5-pro-preview-tts",
			"gemini-3.1-flash-tts-preview",
		]);
		expect(GOOGLE_TTS_VOICES).toContain("Kore");
		expect(GOOGLE_TTS_VOICES).toHaveLength(30);
	});

	it("asks the Interactions API for audio with a named voice", () => {
		const body = speechBody("Puck");
		expect(body.response_format.type).toBe("audio");
		expect(body.generation_config.speech_config[0]?.voice).toBe("Puck");
		expect(body.input).toBe("hello");
	});

	it("rejects a voice the model does not offer", async () => {
		const result = await google.generateAudio({
			model: "gemini-3.1-flash-tts-preview",
			prompt: "hello",
			voice: "not-a-voice",
		});
		expect(result.success).toBe(false);
		expect(result.error).toMatch(/not "not-a-voice"/);
	});
});
