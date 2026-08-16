import type { AIModelConfig } from "../constants/model.types";

/**
 * BytePlus ModelArk (Seedance).
 *
 * Ark rejects a field the model does not accept with a 400 rather than ignoring
 * it — `"the specified parameter 'draft' is not supported for model
 * seedance-1-0-pro in t2v, must be empty"` — so the adapter cannot serialize a
 * whole option struct. This table is what tells it which fields are legal, and
 * it is the reason the table exists at all.
 */
export type SeedanceFamily = "1.0" | "1.5" | "2.x";

export interface BytePlusModelBinding {
	/** Ark's model id, which is also our catalog id — they need no translation. */
	family: SeedanceFamily;
	textToVideo: boolean;
	imageToVideo: boolean;
	/** Accepts a `last_frame` alongside `first_frame`. */
	lastFrame: boolean;
	/** Max `reference_image` items, or 0 where the family rejects them. */
	referenceImages: number;
	/** Accepts `reference_video` / `reference_audio`. */
	referenceMedia: boolean;
	durations: { min: number; max: number };
	resolutions: string[];
	/**
	 * What Ark uses when `resolution` is omitted. The 1.0-pro models default to
	 * 1080p, and billing scales with pixels, so the adapter always sends it.
	 */
	defaultResolution: string;
}

/**
 * BytePlus bills video by token, not by second, with a published formula:
 *
 *   tokens = (input duration + output duration) x width x height x fps / 1024
 *
 * The per-second rates below are that formula applied to the published
 * USD-per-million-token rates. The arithmetic is kept here rather than folded
 * into a constant so the derivation stays checkable when the rates move.
 */
const FPS = 24;
const PIXELS: Record<string, [number, number]> = {
	"480p": [854, 480],
	"720p": [1280, 720],
	"1080p": [1920, 1080],
	"4k": [3840, 2160],
};

function usdPerSecond(
	usdPerMillionTokens: Record<string, number>,
): Record<string, number> {
	const out: Record<string, number> = {};
	for (const [resolution, rate] of Object.entries(usdPerMillionTokens)) {
		const [w, h] = PIXELS[resolution] ?? [0, 0];
		const tokensPerSecond = (w * h * FPS) / 1024;
		out[resolution] = Number(((tokensPerSecond * rate) / 1_000_000).toFixed(4));
	}
	return out;
}

/** Published USD per million tokens, text-to-video (no input video). */
const TOKEN_RATES: Record<string, Record<string, number>> = {
	"dreamina-seedance-2-5-260628": { "480p": 10.7, "720p": 10.7, "1080p": 11.7 },
	"dreamina-seedance-2-0-260128": {
		"480p": 7.0,
		"720p": 7.0,
		"1080p": 7.7,
		"4k": 4.0,
	},
	"dreamina-seedance-2-0-fast-260128": { "480p": 5.6, "720p": 5.6 },
	"dreamina-seedance-2-0-mini-260615": { "480p": 3.5, "720p": 3.5 },
};

/** Seedream bills a flat rate per generated image. */
const IMAGE_USD: Record<string, number> = {
	"dola-seedream-5-0-pro-260628": 0.045,
	"seedream-5-0-260128": 0.035,
	"seedream-4-5-251128": 0.04,
	"seedream-4-0-250828": 0.03,
	"seedream-4-0-20260415": 0.03,
	"seededit-3-0-i2i-250628": 0.03,
};

const RATIOS = ["16:9", "4:3", "1:1", "3:4", "9:16", "21:9"];

export const BYTEPLUS_MODELS: Record<string, BytePlusModelBinding> = {
	"seedance-1-0-lite-t2v-250428": {
		family: "1.0",
		textToVideo: true,
		imageToVideo: false,
		lastFrame: false,
		referenceImages: 0,
		referenceMedia: false,
		durations: { min: 2, max: 12 },
		resolutions: ["480p", "720p", "1080p"],
		defaultResolution: "720p",
	},
	"seedance-1-0-lite-i2v-250428": {
		family: "1.0",
		textToVideo: false,
		imageToVideo: true,
		lastFrame: true,
		referenceImages: 4,
		referenceMedia: false,
		durations: { min: 2, max: 12 },
		resolutions: ["480p", "720p", "1080p"],
		defaultResolution: "720p",
	},
	"seedance-1-0-pro-250528": {
		family: "1.0",
		textToVideo: true,
		imageToVideo: true,
		lastFrame: true,
		referenceImages: 0,
		referenceMedia: false,
		durations: { min: 2, max: 12 },
		resolutions: ["480p", "720p", "1080p"],
		defaultResolution: "1080p",
	},
	// Verified in the docs: this one alone drops last-frame support.
	"seedance-1-0-pro-fast-251015": {
		family: "1.0",
		textToVideo: true,
		imageToVideo: true,
		lastFrame: false,
		referenceImages: 0,
		referenceMedia: false,
		durations: { min: 2, max: 12 },
		resolutions: ["480p", "720p", "1080p"],
		defaultResolution: "1080p",
	},
	"seedance-1-5-pro-251215": {
		family: "1.5",
		textToVideo: true,
		imageToVideo: true,
		lastFrame: true,
		referenceImages: 0,
		referenceMedia: false,
		durations: { min: 4, max: 12 },
		resolutions: ["480p", "720p", "1080p"],
		defaultResolution: "720p",
	},
	"dreamina-seedance-2-0-260128": {
		family: "2.x",
		textToVideo: true,
		imageToVideo: true,
		lastFrame: true,
		referenceImages: 9,
		referenceMedia: true,
		durations: { min: 4, max: 15 },
		// The only Seedance model with a 4k tier. It is 10-bit HEVC, so a browser
		// may refuse to play it inline.
		resolutions: ["480p", "720p", "1080p", "4k"],
		defaultResolution: "720p",
	},
	"dreamina-seedance-2-0-fast-260128": {
		family: "2.x",
		textToVideo: true,
		imageToVideo: true,
		lastFrame: true,
		referenceImages: 9,
		referenceMedia: true,
		durations: { min: 4, max: 15 },
		resolutions: ["480p", "720p"],
		defaultResolution: "720p",
	},
	"dreamina-seedance-2-0-mini-260615": {
		family: "2.x",
		textToVideo: true,
		imageToVideo: true,
		lastFrame: true,
		referenceImages: 9,
		referenceMedia: true,
		durations: { min: 4, max: 15 },
		resolutions: ["480p", "720p"],
		defaultResolution: "720p",
	},
	"dreamina-seedance-2-5-260628": {
		family: "2.x",
		textToVideo: true,
		imageToVideo: true,
		lastFrame: true,
		referenceImages: 30,
		referenceMedia: true,
		durations: { min: 4, max: 30 },
		resolutions: ["480p", "720p"],
		defaultResolution: "720p",
	},
};

/** Fields each family accepts. Sending one outside its family is a 400. */
export function fieldsFor(family: SeedanceFamily): {
	seed: boolean;
	cameraFixed: boolean;
	generateAudio: boolean;
	priority: boolean;
} {
	return {
		seed: family !== "2.x",
		cameraFixed: family !== "2.x",
		generateAudio: family !== "1.0",
		priority: family === "2.x",
	};
}

/**
 * Image models. Unlike video, `/images/generations` answers synchronously — the
 * image is in the response, there is no task to poll.
 */
export const BYTEPLUS_IMAGE_MODELS: Record<string, { sizes: string[] }> = {
	"seedream-3-0-t2i-250415": { sizes: ["1K", "2K"] },
	"seededit-3-0-i2i-250628": { sizes: ["1K", "2K"] },
	"seedream-4-0-250828": { sizes: ["1K", "2K", "4K"] },
	"seedream-4-0-20260415": { sizes: ["1K", "2K", "4K"] },
	"seedream-4-5-251128": { sizes: ["1K", "2K", "4K"] },
	"seedream-5-0-260128": { sizes: ["1K", "2K", "4K"] },
	"dola-seedream-5-0-pro-260628": { sizes: ["1K", "2K", "4K"] },
};

export const BYTEPLUS_IMAGE_CATALOG: AIModelConfig[] = Object.entries(
	BYTEPLUS_IMAGE_MODELS,
).map(([id, spec]) => ({
	id,
	name: id.replace(/-\d{6,}$/, "").replace(/-/g, " "),
	category: "image",
	inputType: id.includes("i2i") ? "image_required" : "image_optional",
	nodeTypes: ["image_gen"],
	creditsPerUnit: 0,
	creditUnit: "image",
	supportedResolutions: spec.sizes,
	supportedAspectRatios: RATIOS,
	provider: "byteplus",
	pricing: IMAGE_USD[id]
		? { unit: "image", usdPerUnit: IMAGE_USD[id] }
		: undefined,
}));

export const BYTEPLUS_CATALOG: AIModelConfig[] = Object.entries(
	BYTEPLUS_MODELS,
).map(([id, binding]) => ({
	id,
	name: id
		.replace(/-\d{6,}$/, "")
		.replace(/^dreamina-/, "")
		.replace(/-/g, " "),
	category: "video",
	inputType: binding.textToVideo
		? binding.imageToVideo
			? "image_optional"
			: "text_only"
		: "image_required",
	nodeTypes: ["video_gen"],
	// BytePlus bills your own Ark account per output token.
	creditsPerUnit: 0,
	creditUnit: "second",
	minDuration: binding.durations.min,
	maxDuration: binding.durations.max,
	supportedResolutions: binding.resolutions,
	supportedAspectRatios: RATIOS,
	provider: "byteplus",
	pricing: TOKEN_RATES[id]
		? {
				unit: "second",
				byResolution: usdPerSecond(TOKEN_RATES[id]),
				usdPerUnit:
					usdPerSecond(TOKEN_RATES[id])[binding.defaultResolution] ?? 0,
			}
		: undefined,
}));
