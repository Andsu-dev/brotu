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
];
