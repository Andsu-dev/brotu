import type { AIModelConfig } from "../constants/model.types";

/**
 * Kling runs two HTTP APIs side by side on the same host.
 *
 * - `v1`   — `POST /v1/videos/{text2video,image2video}`, body `{model_name, prompt, image}`,
 *            polled per-kind, reports `succeed`, results under `task_result.videos[]`.
 * - `next` — `POST /{text-to-video,image-to-video}/{model}`, body `{prompt|contents, settings}`,
 *            polled through one `GET /tasks`, reports `succeeded`, results under `outputs[]`.
 *
 * Newer models exist only on `next`, older ones only on `v1`. Everything in this
 * file was verified against the live API by probing validation order: the server
 * checks fields one at a time, so an intentionally invalid later field reveals
 * whether the earlier one was accepted, without ever queueing a paid task.
 */
export type KlingApi = "v1" | "next";

export interface KlingModelBinding {
	/** What the API calls it, which differs from our catalog id. */
	modelName: string;
	api: KlingApi;
	kind: "video" | "image";
	imageToVideo?: boolean;
	textToVideo?: boolean;
	/** Exactly the durations the API accepts. Anything else is rejected. */
	durations?: number[];
	resolutions?: string[];
	/** `kling-v1-5` rejects "std" on text2video. */
	modes?: Array<"std" | "pro">;
	/** `kling-3.0-turbo` takes a first frame only. Defaults to true. */
	lastFrame?: boolean;
}

const V1_DURATIONS = [5, 10];
// The docs list every integer 3..15, but 9, 11, 13 and 14 are rejected in
// production. Measured, not read.
const NEXT_DURATIONS = [3, 4, 5, 6, 7, 8, 10, 12, 15];
const HD = ["720p", "1080p"];
// 4k is documented on kling-3.0 alone, not across the newer family.
const UHD = ["720p", "1080p", "4k"];
/**
 * Published USD per second of output. Kling quotes these in "Units" ($0.14
 * each); the dollar figures are the ones printed alongside on the pricing page.
 * These are the plain no-native-audio rates — native audio, voice control and
 * motion control each cost more, so a request using them bills above this.
 */
const USD_PER_SECOND: Record<string, Record<string, number>> = {
	"kling/v1-5": { "720p": 0.056, "1080p": 0.098 },
	"kling/v1-6": { "720p": 0.056, "1080p": 0.098 },
	"kling/v2-master": { "1080p": 0.28 },
	"kling/v2-1": { "720p": 0.056, "1080p": 0.098 },
	"kling/v2-1-master": { "1080p": 0.28 },
	"kling/v2-5-turbo": { "720p": 0.042, "1080p": 0.07 },
	"kling/v2-6": { "720p": 0.042, "1080p": 0.07 },
	"kling/v3": { "720p": 0.084, "1080p": 0.112, "4k": 0.42 },
	"kling/v3-turbo": { "720p": 0.112, "1080p": 0.14 },
};

const ASPECT_RATIOS = ["16:9", "9:16", "1:1"];

export const KLING_MODELS: Record<string, KlingModelBinding> = {
	// ---- legacy API ----
	"kling/v1": {
		modelName: "kling-v1",
		api: "v1",
		kind: "video",
		textToVideo: true,
		imageToVideo: true,
		durations: V1_DURATIONS,
	},
	"kling/v1-5": {
		modelName: "kling-v1-5",
		api: "v1",
		kind: "video",
		textToVideo: true,
		imageToVideo: true,
		durations: V1_DURATIONS,
		modes: ["pro"],
	},
	"kling/v1-6": {
		modelName: "kling-v1-6",
		api: "v1",
		kind: "video",
		textToVideo: true,
		imageToVideo: true,
		durations: V1_DURATIONS,
	},
	"kling/v2-master": {
		modelName: "kling-v2-master",
		api: "v1",
		kind: "video",
		textToVideo: true,
		imageToVideo: true,
		durations: V1_DURATIONS,
	},
	// Verified: rejected on text2video, accepted on image2video.
	"kling/v2-1": {
		modelName: "kling-v2-1",
		api: "v1",
		kind: "video",
		imageToVideo: true,
		durations: V1_DURATIONS,
	},
	"kling/v2-1-master": {
		modelName: "kling-v2-1-master",
		api: "v1",
		kind: "video",
		textToVideo: true,
		imageToVideo: true,
		durations: V1_DURATIONS,
	},

	// ---- path-versioned API ----
	"kling/v2-5-turbo": {
		modelName: "kling-2.5-turbo",
		api: "next",
		kind: "video",
		textToVideo: true,
		imageToVideo: true,
		durations: V1_DURATIONS,
		resolutions: HD,
	},
	"kling/v2-6": {
		modelName: "kling-2.6",
		api: "next",
		kind: "video",
		textToVideo: true,
		imageToVideo: true,
		durations: V1_DURATIONS,
		resolutions: HD,
	},
	"kling/v3": {
		modelName: "kling-3.0",
		api: "next",
		kind: "video",
		textToVideo: true,
		imageToVideo: true,
		durations: NEXT_DURATIONS,
		resolutions: UHD,
	},
	"kling/v3-turbo": {
		modelName: "kling-3.0-turbo",
		api: "next",
		kind: "video",
		textToVideo: true,
		imageToVideo: true,
		durations: NEXT_DURATIONS,
		// 3.0-turbo caps at 1080p, unlike 3.0.
		resolutions: HD,
		lastFrame: false,
	},

	// ---- images, legacy API ----
	"kling/image-v1": { modelName: "kling-v1", api: "v1", kind: "image" },
	"kling/image-v1-5": { modelName: "kling-v1-5", api: "v1", kind: "image" },
	"kling/image-v2": { modelName: "kling-v2", api: "v1", kind: "image" },
	"kling/image-v2-new": { modelName: "kling-v2-new", api: "v1", kind: "image" },
	"kling/image-v2-1": { modelName: "kling-v2-1", api: "v1", kind: "image" },
};

/**
 * Speech. `POST /v1/audio/tts`, which is a third dialect on this host: its body
 * is snake_case, while the path-versioned video API uses `contents`/`settings`
 * and the legacy one uses `model_name`. Sending camelCase here lands in another
 * DTO and reports a misleading "must not be blank" for fields you did send.
 *
 * Every id below was verified against the live API — an unknown one answers
 * "Voice id not found", so this list is measured rather than transcribed.
 */
export const KLING_VOICES = [
	"genshin_vindi2",
	"zhinen_xuesheng",
	"ai_shatang",
	"genshin_klee2",
	"genshin_kirara",
	"ai_kaiya",
	"chat1_female_new-3",
	"cartoon-boy-07",
	"cartoon-girl-01",
	"uk_boy1",
	"uk_man2",
	"PeppaPig_platform",
	"ai_huangzhong_712",
	"ai_huangyaoshi_712",
	"ai_laoguowang_712",
	"chengshu_jiejie",
	"you_pingjing",
	"calm_story1",
	"laopopo_speech02",
	"heainainai_speech02",
] as const;

/** Speech is one endpoint, not a family, so the catalog carries one entry. */
export const KLING_AUDIO_MODEL = "kling/tts";

export const KLING_AUDIO_CATALOG: AIModelConfig[] = [
	{
		id: KLING_AUDIO_MODEL,
		name: "Kling TTS",
		category: "audio",
		inputType: "text_only",
		nodeTypes: ["text"],
		creditsPerUnit: 0,
		creditUnit: "character",
		provider: "kling",
		description: `Preset voices: ${KLING_VOICES.join(", ")}. Cloned voices from your account work too.`,
	},
];

function label(id: string): string {
	const name = KLING_MODELS[id]?.modelName ?? id;
	return `Kling ${name.replace(/^kling-v?/, "")}`;
}

/** Catalog entries for every Kling model, all routed to the native adapter. */
export const KLING_CATALOG: AIModelConfig[] = Object.entries(KLING_MODELS).map(
	([id, binding]) => {
		if (binding.kind === "image") {
			return {
				id,
				name: `${label(id)} (image)`,
				category: "image",
				inputType: "text_only",
				nodeTypes: ["image_gen"],
				// Kling bills its own account, so there is nothing for us to price.
				creditsPerUnit: 0,
				creditUnit: "image",
				supportedAspectRatios: ASPECT_RATIOS,
				provider: "kling",
			} satisfies AIModelConfig;
		}

		const durations = binding.durations ?? V1_DURATIONS;
		return {
			id,
			name: label(id),
			category: "video",
			inputType: binding.textToVideo
				? binding.imageToVideo
					? "image_optional"
					: "text_only"
				: "image_required",
			nodeTypes: ["video_gen"],
			creditsPerUnit: 0,
			creditUnit: "second",
			minDuration: durations[0],
			maxDuration: durations[durations.length - 1],
			durationOptions: durations,
			supportedResolutions: binding.resolutions,
			supportedAspectRatios: ASPECT_RATIOS,
			provider: "kling",
			pricing: USD_PER_SECOND[id]
				? {
						unit: "second",
						byResolution: USD_PER_SECOND[id],
						usdPerUnit:
							USD_PER_SECOND[id]["720p"] ?? USD_PER_SECOND[id]["1080p"] ?? 0,
					}
				: undefined,
		} satisfies AIModelConfig;
	},
);

// ---------------------------------------------------------------------------
// Capabilities beyond plain text/image-to-video.
//
// They all submit, queue and get polled the same way, and differ on exactly
// three axes: which API family serves them, what the body looks like, and where
// the result lands. So they are declared as data and run by one executor,
// rather than written as ten near-identical methods.
//
// They are exposed under `ai.kling.*` rather than the portable `ai.video.*`
// surface on purpose. Motion transfer, element libraries and canvas expansion
// are not things another provider implements the same way, and a shared
// signature would be an abstraction nobody could later undo.
// ---------------------------------------------------------------------------

/** Where a capability's results land in the polled task. */
export type KlingResultField = "outputs" | "videos" | "images" | "elements";

export interface KlingCapability<TInput> {
	/** Path to POST to. A function because some embed the model. */
	path: (input: TInput) => string;
	api: KlingApi;
	body: (input: TInput) => Record<string, unknown>;
	results: KlingResultField;
	/** Media kind of the result, for the output mime type. */
	kind: "video" | "image" | "element";
}

/** Options every path-versioned capability accepts. */
export interface KlingRequestOptions {
	callbackUrl?: string;
	/** Your own id for the task. Must be unique within your account. */
	externalTaskId?: string;
	watermark?: boolean;
}

function optionsBlock(options?: KlingRequestOptions) {
	if (!options) return undefined;
	const block: Record<string, unknown> = {};
	if (options.callbackUrl) block.callback_url = options.callbackUrl;
	if (options.externalTaskId) block.external_task_id = options.externalTaskId;
	if (options.watermark !== undefined) {
		block.watermark_info = { enabled: options.watermark };
	}
	return Object.keys(block).length > 0 ? block : undefined;
}

// ---------------------------------------------------------------- motion control

export interface MotionControlInput {
	/** `kling-3.0` or `kling-2.6`. */
	model?: "kling-3.0" | "kling-2.6";
	/** The character you want. URL or bare base64. */
	imageUrl: string;
	/** The movement you want. URL only, mp4/mov, max 100MB. */
	videoUrl: string;
	/**
	 * Whose framing the output follows. `image` caps the reference video at 10s,
	 * `video` allows 30s.
	 */
	characterOrientation: "image" | "video";
	prompt?: string;
	resolution?: "720p" | "1080p";
	/** Defaults to `original` here, unlike every other endpoint. */
	audio?: "original" | "off";
	options?: KlingRequestOptions;
}

export const motionControl: KlingCapability<MotionControlInput> = {
	api: "next",
	kind: "video",
	results: "outputs",
	path: (input) => `/motion-control/${input.model ?? "kling-2.6"}`,
	body: (input) => {
		const contents: Array<Record<string, unknown>> = [];
		if (input.prompt) contents.push({ type: "prompt", text: input.prompt });
		// This endpoint uses `image` and `video`, not first_frame / feature_video.
		contents.push({ type: "image", url: input.imageUrl });
		contents.push({ type: "video", url: input.videoUrl });

		const settings: Record<string, unknown> = {
			character_orientation: input.characterOrientation,
		};
		if (input.resolution) settings.resolution = input.resolution;
		if (input.audio) settings.audio = input.audio;

		const options = optionsBlock(input.options);
		return options ? { contents, settings, options } : { contents, settings };
	},
};

// ------------------------------------------------------------------- omni video

export interface OmniVideoReference {
	/** `refer_image` is a free-standing style or scene reference. */
	type:
		| "first_frame"
		| "last_frame"
		| "refer_image"
		| "feature_video"
		| "base_video";
	url: string;
	/** Task-local id, cited in the prompt as `@id`. */
	id?: string;
}

export interface OmniVideoInput {
	model?: "kling-3.0-omni" | "kling-o1";
	prompt: string;
	references?: OmniVideoReference[];
	/** Library elements, cited in the prompt as `@id`. */
	elements?: Array<{ elementId: string; id: string }>;
	resolution?: "720p" | "1080p" | "4k";
	duration?: number;
	/** `original` keeps the reference video's own audio track. */
	audio?: "native" | "original" | "off";
	/** Required when there is neither a first frame nor a reference video. */
	aspectRatio?: "16:9" | "9:16" | "1:1";
	multiShot?: boolean;
	options?: KlingRequestOptions;
}

export const omniVideo: KlingCapability<OmniVideoInput> = {
	api: "next",
	kind: "video",
	results: "outputs",
	path: (input) => `/omni-video/${input.model ?? "kling-3.0-omni"}`,
	body: (input) => {
		const contents: Array<Record<string, unknown>> = [
			{ type: "prompt", text: input.prompt },
		];
		for (const reference of input.references ?? []) {
			contents.push({
				type: reference.type,
				url: reference.url,
				...(reference.id ? { id: reference.id } : {}),
			});
		}
		for (const element of input.elements ?? []) {
			contents.push({
				type: "element",
				element_id: element.elementId,
				id: element.id,
			});
		}

		const settings: Record<string, unknown> = {};
		if (input.resolution) settings.resolution = input.resolution;
		if (input.duration) settings.duration = input.duration;
		if (input.audio) settings.audio = input.audio;
		if (input.aspectRatio) settings.aspect_ratio = input.aspectRatio;
		if (input.multiShot !== undefined) settings.multi_shot = input.multiShot;

		const options = optionsBlock(input.options);
		return {
			contents,
			...(Object.keys(settings).length > 0 ? { settings } : {}),
			...(options ? { options } : {}),
		};
	},
};

// ----------------------------------------------------------------------- avatar

export interface AvatarInput {
	/** Portrait. URL or bare base64, max 10MB. */
	imageUrl: string;
	/** Either an id from the TTS API, or a sound file. Exactly one. */
	audioId?: string;
	soundFileUrl?: string;
	/** Drives gestures, emotion and camera movement. */
	prompt?: string;
	mode?: "std" | "pro";
	options?: KlingRequestOptions;
}

export const avatar: KlingCapability<AvatarInput> = {
	api: "v1",
	kind: "video",
	results: "videos",
	path: () => "/v1/videos/avatar/image2video",
	body: (input) => {
		if (Boolean(input.audioId) === Boolean(input.soundFileUrl)) {
			throw new Error(
				"Avatar needs exactly one of audioId or soundFileUrl, not both and not neither.",
			);
		}
		const body: Record<string, unknown> = { image: input.imageUrl };
		if (input.audioId) body.audio_id = input.audioId;
		if (input.soundFileUrl) body.sound_file = input.soundFileUrl;
		if (input.prompt) body.prompt = input.prompt;
		if (input.mode) body.mode = input.mode;
		if (input.options?.callbackUrl)
			body.callback_url = input.options.callbackUrl;
		if (input.options?.externalTaskId) {
			body.external_task_id = input.options.externalTaskId;
		}
		if (input.options?.watermark !== undefined) {
			body.watermark_info = { enabled: input.options.watermark };
		}
		return body;
	},
};

// ------------------------------------------------------------------ outpainting

export interface OutpaintingInput {
	imageUrl: string;
	/**
	 * All four are required even at zero. Up/down multiply the original height,
	 * left/right the original width. The result may not exceed 3x the original area.
	 */
	up: number;
	down: number;
	left: number;
	right: number;
	prompt?: string;
	n?: number;
	options?: KlingRequestOptions;
}

export const outpainting: KlingCapability<OutpaintingInput> = {
	api: "v1",
	kind: "image",
	results: "images",
	path: () => "/v1/images/editing/expand",
	body: (input) => {
		for (const [name, value] of [
			["up", input.up],
			["down", input.down],
			["left", input.left],
			["right", input.right],
		] as const) {
			if (value < 0 || value > 2) {
				throw new Error(
					`Outpainting ${name} must be between 0 and 2, got ${value}.`,
				);
			}
		}

		const body: Record<string, unknown> = {
			image: input.imageUrl,
			up_expansion_ratio: input.up,
			down_expansion_ratio: input.down,
			left_expansion_ratio: input.left,
			right_expansion_ratio: input.right,
		};
		if (input.prompt) body.prompt = input.prompt;
		if (input.n) body.n = input.n;
		if (input.options?.watermark !== undefined) {
			body.watermark_info = { enabled: input.options.watermark };
		}
		return body;
	},
};

// ------------------------------------------------------------------- image omni

export interface ImageOmniInput {
	model?: "kling-image-o1" | "kling-v3-omni";
	/** Reference images are cited positionally as `<<<image_1>>>`. */
	prompt: string;
	imageUrls?: string[];
	elementIds?: string[];
	resolution?: "1k" | "2k" | "4k";
	/** `series` emits a coherent set instead of one image. */
	resultType?: "single" | "series";
	seriesAmount?: number | "auto";
	n?: number;
	aspectRatio?: string;
	options?: KlingRequestOptions;
}

export const imageOmni: KlingCapability<ImageOmniInput> = {
	api: "v1",
	kind: "image",
	results: "images",
	path: () => "/v1/images/omni-image",
	body: (input) => {
		const images = input.imageUrls ?? [];
		const elements = input.elementIds ?? [];
		if (images.length + elements.length > 10) {
			throw new Error(
				`Image-omni takes at most 10 references in total, got ${images.length + elements.length}.`,
			);
		}

		const body: Record<string, unknown> = {
			model_name: input.model ?? "kling-image-o1",
			prompt: input.prompt,
		};
		if (images.length > 0) {
			body.image_list = images.map((image) => ({ image }));
		}
		if (elements.length > 0) {
			body.element_list = elements.map((id) => ({ element_id: id }));
		}
		if (input.resolution) body.resolution = input.resolution;
		if (input.resultType) body.result_type = input.resultType;
		if (input.seriesAmount) body.series_amount = input.seriesAmount;
		if (input.n) body.n = input.n;
		if (input.aspectRatio) body.aspect_ratio = input.aspectRatio;
		if (input.options?.watermark !== undefined) {
			body.watermark_info = { enabled: input.options.watermark };
		}
		return body;
	},
};

export const KLING_CAPABILITIES = {
	motionControl,
	omniVideo,
	avatar,
	outpainting,
	imageOmni,
} as const;
