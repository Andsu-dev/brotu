import type { AIModelConfig } from "../constants/model.types";

/**
 * Google, through the Gemini Developer API rather than Vertex AI: it takes a
 * plain API key instead of minting service-account tokens against a project and
 * a region.
 *
 * The host serves two conventions at once. Image generation goes through the
 * newer Interactions API with snake_case `input`/`response_format`; Veo uses the
 * older `instances`/`parameters` predict envelope in camelCase. One serializer
 * cannot produce both, which is why the two are modelled separately here.
 *
 * Imagen is deliberately absent — Imagen 4 shut down on 17 August 2026 and its
 * reference page is now only a deprecation notice.
 */

export interface GoogleImageBinding {
	/** `512px` is lite-only; the rest are uppercase K by the vendor's own spec. */
	sizes: string[];
	/** USD per image at 1K, since billing is token-based and scales with size. */
	usdAt1K: number;
}

export const GOOGLE_IMAGE_MODELS: Record<string, GoogleImageBinding> = {
	// Google's recommended default.
	"gemini-3.1-flash-image": { sizes: ["1K", "2K", "4K"], usdAt1K: 0.067 },
	"gemini-3.1-flash-lite-image": {
		// The only model that takes 512px, and note the lowercase "px" against
		// the uppercase "K" of every other value.
		sizes: ["512px", "1K", "2K"],
		usdAt1K: 0.0336,
	},
	"gemini-3-pro-image": { sizes: ["1K", "2K", "4K"], usdAt1K: 0.134 },
	"gemini-2.5-flash-image": { sizes: ["1K", "2K"], usdAt1K: 0.039 },
};

export interface GoogleVideoBinding {
	/**
	 * Which of the host's two APIs serves it. Veo uses the older
	 * `instances`/`parameters` predict envelope in camelCase; Omni uses the same
	 * Interactions API as images, in snake_case. They cannot share a serializer.
	 */
	api: "predict" | "interactions";
	resolutions: string[];
	/** Sent as a string, not a number. */
	durations: string[];
	referenceImages: boolean;
	/** Omni refines a previous result through `previous_interaction_id`. */
	conversationalEditing?: boolean;
	/** USD per second, when published. Omni's rate is not on the pricing page. */
	usdPerSecond?: number;
	/** Per-second rates that differ by resolution. */
	usdByResolution?: Record<string, number>;
}

export const GOOGLE_VIDEO_MODELS: Record<string, GoogleVideoBinding> = {
	// Every current Veo id carries the -preview suffix; the bare name 404s.
	"veo-3.1-generate-preview": {
		api: "predict",
		usdByResolution: { "720p": 0.4, "1080p": 0.4, "4k": 0.6 },
		resolutions: ["720p", "1080p", "4k"],
		durations: ["4", "6", "8"],
		referenceImages: true,
		usdPerSecond: 0.4,
	},
	"veo-3.1-fast-generate-preview": {
		api: "predict",
		usdByResolution: { "720p": 0.1, "1080p": 0.12, "4k": 0.3 },
		resolutions: ["720p", "1080p", "4k"],
		durations: ["4", "6", "8"],
		referenceImages: true,
		usdPerSecond: 0.1,
	},
	"veo-3.1-lite-generate-preview": {
		api: "predict",
		usdByResolution: { "720p": 0.05, "1080p": 0.08 },
		resolutions: ["720p", "1080p"],
		durations: ["4", "6", "8"],
		referenceImages: false,
		usdPerSecond: 0.05,
	},

	/**
	 * Omni: text, image, audio and video in, video out, and results you refine by
	 * talking to them. It sits on the Interactions API rather than Veo's predict
	 * endpoint, which is why the binding carries `api`.
	 *
	 * No published rate — the pricing page lists Veo but not this, so the catalog
	 * leaves it unset rather than guessing.
	 */
	"gemini-omni-flash-preview": {
		api: "interactions",
		resolutions: ["720p"],
		durations: ["10"],
		referenceImages: true,
		conversationalEditing: true,
	},
};

/**
 * Gemini text, through the same Interactions API as images. Rates are USD per
 * million output tokens, list price on the Gemini Developer API paid tier.
 * Promotional intro rates (3.6 / 3.7 through 31 Dec 2026) are what the
 * pricing page shows today; a guess at the 2027 step-up would go stale.
 */
export const GOOGLE_TEXT_MODELS: Record<
	string,
	{ usdPerMillionOutput?: number }
> = {
	"gemini-3.7-flash": { usdPerMillionOutput: 3.75 },
	"gemini-3.6-flash": { usdPerMillionOutput: 3.75 },
	"gemini-3.5-flash": { usdPerMillionOutput: 9 },
	"gemini-3.5-flash-lite": {},
	"gemini-3.1-flash-lite": {},
	"gemini-3.1-pro-preview": { usdPerMillionOutput: 12 },
	"gemini-3-flash-preview": {},
	"gemini-2.5-pro": {},
	"gemini-2.5-flash": {},
	"gemini-2.5-flash-lite": {},
};

/**
 * Official prebuilt voices for Gemini TTS. The Interactions API takes one of
 * these in `generation_config.speech_config[].voice`.
 */
export const GOOGLE_TTS_VOICES = [
	"Zephyr",
	"Puck",
	"Charon",
	"Kore",
	"Fenrir",
	"Leda",
	"Orus",
	"Aoede",
	"Callirrhoe",
	"Autonoe",
	"Enceladus",
	"Iapetus",
	"Umbriel",
	"Algieba",
	"Despina",
	"Erinome",
	"Algenib",
	"Rasalgethi",
	"Laomedeia",
	"Achernar",
	"Alnilam",
	"Schedar",
	"Gacrux",
	"Pulcherrima",
	"Achird",
	"Zubenelgenubi",
	"Vindemiatrix",
	"Sadachbia",
	"Sadaltager",
	"Sulafat",
] as const;

export type GoogleTtsVoice = (typeof GOOGLE_TTS_VOICES)[number];

/**
 * Gemini TTS. Audio-only in, audio-only out, on the Interactions API.
 * Token rates are not listed next to the model cards the way Veo is, so
 * the catalog leaves them unset rather than guessing.
 */
export const GOOGLE_AUDIO_MODELS: Record<
	string,
	{ voices: readonly string[] }
> = {
	"gemini-3.1-flash-tts-preview": { voices: GOOGLE_TTS_VOICES },
	"gemini-2.5-flash-preview-tts": { voices: GOOGLE_TTS_VOICES },
	"gemini-2.5-pro-preview-tts": { voices: GOOGLE_TTS_VOICES },
};

export const GOOGLE_CATALOG: AIModelConfig[] = [
	...Object.entries(GOOGLE_IMAGE_MODELS).map(
		([id, binding]) =>
			({
				id,
				name: id,
				category: "image",
				inputType: "image_optional",
				nodeTypes: ["image_gen"],
				creditsPerUnit: 0,
				creditUnit: "image",
				supportedResolutions: binding.sizes,
				provider: "google",
				pricing: { usdPerUnit: binding.usdAt1K, unit: "image" },
			}) satisfies AIModelConfig,
	),
	...Object.entries(GOOGLE_VIDEO_MODELS).map(
		([id, binding]) =>
			({
				id,
				name: id,
				category: "video",
				inputType: "image_optional",
				nodeTypes: ["video_gen"],
				creditsPerUnit: 0,
				creditUnit: "second",
				durationOptions: binding.durations.map(Number),
				minDuration: Number(binding.durations[0]),
				maxDuration: Number(binding.durations[binding.durations.length - 1]),
				supportedResolutions: binding.resolutions,
				supportedAspectRatios: ["16:9", "9:16"],
				provider: "google",
				pricing:
					binding.usdPerSecond === undefined
						? undefined
						: {
								unit: "second",
								usdPerUnit: binding.usdPerSecond,
								byResolution: binding.usdByResolution,
							},
			}) satisfies AIModelConfig,
	),
	...Object.entries(GOOGLE_TEXT_MODELS).map(
		([id, binding]) =>
			({
				id,
				name: id,
				category: "text",
				inputType: "image_optional",
				nodeTypes: ["text"],
				creditsPerUnit: 0,
				creditUnit: "token",
				provider: "google",
				pricing:
					binding.usdPerMillionOutput === undefined
						? undefined
						: {
								unit: "token",
								usdPerUnit: binding.usdPerMillionOutput / 1_000_000,
							},
			}) satisfies AIModelConfig,
	),
	...Object.entries(GOOGLE_AUDIO_MODELS).map(
		([id, binding]) =>
			({
				id,
				name: id,
				category: "audio",
				inputType: "text_only",
				nodeTypes: ["text"],
				creditsPerUnit: 0,
				creditUnit: "character",
				provider: "google",
				description: `Voices: ${binding.voices.join(", ")}`,
			}) satisfies AIModelConfig,
	),
];
