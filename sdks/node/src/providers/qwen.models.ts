import type { AIModelConfig } from "../constants/model.types";

/**
 * Qwen Cloud, which is Alibaba's DashScope International underneath — the docs
 * brand it Qwen Cloud but the host, key format and task envelope are DashScope.
 * Confirmed live: the same key authenticates chat there and queues video, and a
 * submitted task returned a playable file.
 *
 * These are the native home of the Wan and HappyHorse families, which this SDK
 * previously reached only through an aggregator.
 *
 * Nearly every field below exists because the same endpoint accepts four
 * incompatible request shapes, discriminated only by the model string.
 */

/** How a model wants its reference media passed. */
export type QwenInputShape =
	/** `input.media[]` of `{type,url}` — wan2.7, happyhorse, wan3.0. */
	| "media"
	/** `input.img_url`, a single string — wan2.6 and earlier. */
	| "img_url"
	/** `input.first_frame_url` + `last_frame_url`, on a different path. */
	| "kf2v"
	/** `input.reference_urls[]` of plain strings — wan2.6-r2v. */
	| "reference_urls";

/** How a model wants its output size expressed. */
export type QwenSizing =
	/** `parameters.resolution` + `parameters.ratio`. */
	| "resolution"
	/** `parameters.size`, as "1280*720" with a literal asterisk. */
	| "size";

export type QwenMode = "t2v" | "i2v" | "r2v" | "video-edit" | "kf2v";

export interface QwenVideoBinding {
	mode: QwenMode;
	shape: QwenInputShape;
	sizing: QwenSizing;
	/** Only kf2v leaves the shared video path. */
	path?: string;
	durations?: { min: number; max: number } | number[];
	resolutions?: string[];
	/** True where DashScope stamps a visible mark unless told not to. */
	watermarkOnByDefault?: boolean;
}

const VIDEO_PATH = "/api/v1/services/aigc/video-generation/video-synthesis";
// Keyframe models are the one capability that leaves the shared path.
const KF2V_PATH = "/api/v1/services/aigc/image2video/video-synthesis";

const HD = ["480P", "720P", "1080P"];

export const QWEN_VIDEO_MODELS: Record<string, QwenVideoBinding> = {
	// --- wan 2.7: media objects, resolution + ratio ---
	"wan2.7-t2v": {
		mode: "t2v",
		shape: "media",
		sizing: "resolution",
		durations: { min: 2, max: 15 },
		resolutions: ["720P", "1080P"],
	},
	"wan2.7-i2v": {
		mode: "i2v",
		shape: "media",
		sizing: "resolution",
		durations: { min: 2, max: 15 },
		resolutions: ["720P", "1080P"],
	},

	// --- wan 2.6: img_url string, size ---
	"wan2.6-t2v": {
		mode: "t2v",
		shape: "media",
		sizing: "size",
		durations: { min: 2, max: 15 },
		watermarkOnByDefault: true,
	},
	"wan2.6-i2v": {
		mode: "i2v",
		shape: "img_url",
		sizing: "resolution",
		durations: { min: 2, max: 15 },
		resolutions: ["720P", "1080P"],
	},
	"wan2.6-i2v-flash": {
		mode: "i2v",
		shape: "img_url",
		sizing: "resolution",
		durations: { min: 2, max: 15 },
		resolutions: ["720P", "1080P"],
	},
	"wan2.6-r2v": {
		mode: "r2v",
		shape: "reference_urls",
		sizing: "size",
		durations: { min: 2, max: 10 },
	},

	// --- keyframe: different path, fixed duration, its own fields ---
	"wan2.2-kf2v-flash": {
		mode: "kf2v",
		shape: "kf2v",
		sizing: "resolution",
		path: KF2V_PATH,
		durations: [5],
		resolutions: HD,
	},

	// --- happyhorse: media objects, minimum duration 3, watermark on ---
	"happyhorse-1.1-t2v": {
		mode: "t2v",
		shape: "media",
		sizing: "resolution",
		durations: { min: 3, max: 15 },
		resolutions: HD,
		watermarkOnByDefault: true,
	},
	"happyhorse-1.1-i2v": {
		mode: "i2v",
		shape: "media",
		sizing: "resolution",
		durations: { min: 3, max: 15 },
		resolutions: HD,
		watermarkOnByDefault: true,
	},
	"happyhorse-1.1-r2v": {
		mode: "r2v",
		shape: "media",
		sizing: "resolution",
		durations: { min: 3, max: 15 },
		resolutions: HD,
		watermarkOnByDefault: true,
	},
	"happyhorse-1.0-t2v": {
		mode: "t2v",
		shape: "media",
		sizing: "resolution",
		durations: { min: 3, max: 15 },
		resolutions: HD,
		watermarkOnByDefault: true,
	},
	"happyhorse-1.0-i2v": {
		mode: "i2v",
		shape: "media",
		sizing: "resolution",
		durations: { min: 3, max: 15 },
		resolutions: HD,
		watermarkOnByDefault: true,
	},
	"happyhorse-1.0-r2v": {
		mode: "r2v",
		shape: "media",
		sizing: "resolution",
		durations: { min: 3, max: 15 },
		resolutions: HD,
		watermarkOnByDefault: true,
	},
	"happyhorse-1.0-video-edit": {
		mode: "video-edit",
		shape: "media",
		sizing: "resolution",
		resolutions: ["720P", "1080P"],
		watermarkOnByDefault: true,
	},
};

export function videoPathFor(binding: QwenVideoBinding): string {
	return binding.path ?? VIDEO_PATH;
}

// ---------------------------------------------------------------------- images

/** Which of the three image endpoints a model answers on. */
export type QwenImagePath = "multimodal" | "image-generation" | "text2image";

export const QWEN_IMAGE_PATHS: Record<QwenImagePath, string> = {
	multimodal: "/api/v1/services/aigc/multimodal-generation/generation",
	"image-generation": "/api/v1/services/aigc/image-generation/generation",
	text2image: "/api/v1/services/aigc/text2image/image-synthesis",
};

export interface QwenImageBinding {
	/**
	 * Whether the model answers inline. This is not a preference: sending
	 * `X-DashScope-Async: enable` to a sync-only model returns 429, which reads
	 * as rate limiting and never resolves on retry.
	 */
	sync: boolean;
	path: QwenImagePath;
	/** `messages` is the chat-style body; `prompt` is the legacy flat one. */
	body: "messages" | "prompt";
	maxN: number;
	resolutions?: string[];
}

export const QWEN_IMAGE_MODELS: Record<string, QwenImageBinding> = {
	// Sync and async both available; async uses the newer image-generation path.
	"qwen-image-3.0-pro": {
		sync: true,
		path: "multimodal",
		body: "messages",
		maxN: 6,
	},
	"qwen-image-3.0": {
		sync: true,
		path: "multimodal",
		body: "messages",
		maxN: 6,
	},

	// Sync only — the async header would 429 these.
	"qwen-image-2.0-pro": {
		sync: true,
		path: "multimodal",
		body: "messages",
		maxN: 6,
	},
	"qwen-image-2.0": {
		sync: true,
		path: "multimodal",
		body: "messages",
		maxN: 6,
	},
	"qwen-image-max": {
		sync: true,
		path: "multimodal",
		body: "messages",
		maxN: 1,
	},
	"z-image-turbo": {
		sync: true,
		path: "multimodal",
		body: "messages",
		maxN: 1,
	},

	"wan2.7-image-pro": {
		sync: true,
		path: "multimodal",
		body: "messages",
		maxN: 4,
		resolutions: ["1K", "2K", "4K"],
	},
	"wan2.7-image": {
		sync: true,
		path: "multimodal",
		body: "messages",
		maxN: 4,
		resolutions: ["1K", "2K"],
	},
	"wan2.6-image": {
		sync: true,
		path: "multimodal",
		body: "messages",
		maxN: 4,
	},
	"wan2.6-t2i": { sync: true, path: "multimodal", body: "messages", maxN: 4 },
};

/**
 * Published list price in USD per second. The pricing page shows promotional
 * rates alongside these (happyhorse is 40% off today); the list price is used
 * because a promotion expiring would make the estimate quietly too low.
 *
 * Only the featured models are published — wan2.6 and wan2.7 live in the Model
 * Marketplace, which needs a console login, so they carry no rate here.
 */
const VIDEO_USD_PER_SECOND: Record<string, Record<string, number>> = {
	"happyhorse-1.1-t2v": { "480P": 0.07, "720P": 0.14, "1080P": 0.18 },
	"happyhorse-1.1-i2v": { "480P": 0.07, "720P": 0.14, "1080P": 0.18 },
	"happyhorse-1.1-r2v": { "480P": 0.07, "720P": 0.14, "1080P": 0.18 },
	"happyhorse-1.0-video-edit": { "720P": 0.14, "1080P": 0.24 },
};

/** Published USD per generated image. */
const IMAGE_USD: Record<string, number> = {
	"qwen-image-3.0-pro": 0.04,
	"qwen-image-3.0": 0.03,
	"qwen-image-2.0-pro": 0.075,
	"qwen-image-2.0": 0.035,
	"wan2.7-image-pro": 0.075,
};

/**
 * Speech. Verified live: these answer inline on the multimodal endpoint and hand
 * back an audio URL with a real `expires_at`, so nothing here is inferred.
 *
 * Billing is per character of input text, which the caller knows before asking —
 * unlike text models, an audio estimate can be exact.
 */
export interface QwenVoiceBinding {
	voices: string[];
	/** USD per character. Published as $0.15 per 10K characters. */
	usdPerCharacter: number;
}

const QWEN_VOICES = [
	"Cherry",
	"Ethan",
	"Jennifer",
	"Ryan",
	"Dylan",
	"Sunny",
	"Nofish",
];

export const QWEN_AUDIO_MODELS: Record<string, QwenVoiceBinding> = {
	"qwen3-tts-flash": { voices: QWEN_VOICES, usdPerCharacter: 0.000015 },
	"qwen3-tts-instruct-flash": {
		voices: QWEN_VOICES,
		usdPerCharacter: 0.000015,
	},
	"qwen-audio-3.0-tts-flash": {
		voices: QWEN_VOICES,
		usdPerCharacter: 0.000015,
	},
	"qwen-audio-3.0-tts-plus": { voices: QWEN_VOICES, usdPerCharacter: 0.00003 },
	"cosyvoice-v3-flash": { voices: QWEN_VOICES, usdPerCharacter: 0.000015 },
};

/**
 * Text, through the OpenAI-compatible surface rather than the native one.
 *
 * Priced per million tokens, and the total depends on how much the model writes
 * back — so an estimate can report the rate but never the bill. The catalog
 * carries the rate; `estimateCost` says so rather than guessing a token count.
 */
export const QWEN_TEXT_MODELS: Record<string, { usdPerMillionOutput: number }> =
	{
		"qwen3.8-max": { usdPerMillionOutput: 6 },
		"qwen3.7-plus": { usdPerMillionOutput: 1.6 },
		"qwen3.7-flash": { usdPerMillionOutput: 0.13 },
		"qwen-max": { usdPerMillionOutput: 7.5 },
		"qwen-plus": { usdPerMillionOutput: 3 },
		"qwen-turbo": { usdPerMillionOutput: 0.4 },
	};

function inputTypeFor(mode: QwenMode): AIModelConfig["inputType"] {
	if (mode === "t2v") return "text_only";
	if (mode === "video-edit") return "video_required";
	return "image_required";
}

function durationsOf(binding: QwenVideoBinding) {
	if (Array.isArray(binding.durations)) {
		return {
			options: binding.durations,
			min: binding.durations[0],
			max: binding.durations[binding.durations.length - 1],
		};
	}
	return {
		options: undefined,
		min: binding.durations?.min,
		max: binding.durations?.max,
	};
}

export const QWEN_CATALOG: AIModelConfig[] = [
	...Object.entries(QWEN_AUDIO_MODELS).map(
		([id, binding]) =>
			({
				id,
				name: id,
				category: "audio",
				inputType: "text_only",
				nodeTypes: ["text"],
				creditsPerUnit: 0,
				creditUnit: "character",
				provider: "qwen",
				pricing: { unit: "character", usdPerUnit: binding.usdPerCharacter },
				description: `Voices: ${binding.voices.join(", ")}`,
			}) satisfies AIModelConfig,
	),
	...Object.entries(QWEN_TEXT_MODELS).map(
		([id, binding]) =>
			({
				id,
				name: id,
				category: "text",
				inputType: "text_only",
				nodeTypes: ["text"],
				creditsPerUnit: 0,
				creditUnit: "token",
				provider: "qwen",
				pricing: {
					unit: "token",
					usdPerUnit: binding.usdPerMillionOutput / 1_000_000,
				},
			}) satisfies AIModelConfig,
	),
	...Object.entries(QWEN_VIDEO_MODELS).map(([id, binding]) => {
		const duration = durationsOf(binding);
		return {
			id,
			name: id,
			category: "video",
			inputType: inputTypeFor(binding.mode),
			nodeTypes: ["video_gen"],
			// Qwen bills your own DashScope account.
			creditsPerUnit: 0,
			creditUnit: "second",
			durationOptions: duration.options,
			minDuration: duration.min,
			maxDuration: duration.max,
			supportedResolutions: binding.resolutions,
			provider: "qwen",
			pricing: VIDEO_USD_PER_SECOND[id]
				? {
						unit: "second",
						byResolution: VIDEO_USD_PER_SECOND[id],
						usdPerUnit: VIDEO_USD_PER_SECOND[id]["720P"] ?? 0,
					}
				: undefined,
		} satisfies AIModelConfig;
	}),
	...Object.entries(QWEN_IMAGE_MODELS).map(
		([id, binding]) =>
			({
				id,
				name: id,
				category: "image",
				inputType: "image_optional",
				nodeTypes: ["image_gen"],
				creditsPerUnit: 0,
				creditUnit: "image",
				supportedResolutions: binding.resolutions,
				provider: "qwen",
				pricing: IMAGE_USD[id]
					? { unit: "image", usdPerUnit: IMAGE_USD[id] }
					: undefined,
			}) satisfies AIModelConfig,
	),
];
