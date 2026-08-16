/** What a provider counts when it bills. */
export type BillingUnit =
	| "second"
	| "image"
	| "request"
	/** Text-to-speech, billed on the input text. */
	| "character"
	/** Text models, where the total is only known after generating. */
	| "token";

export type AIModelCategory = "video" | "image" | "text" | "audio";

export type AIInputType =
	| "text_only"
	| "image_required"
	| "image_optional"
	| "video_required";

export type AICreditUnit =
	| "image"
	| "request"
	| "second"
	| "character"
	| "token";

export interface AIRuntimePricingTier {
	creditsPerUnit: number;
	creditUnit: AICreditUnit;
	durationSeconds?: number;
	resolution?: string;
	withAudio?: boolean;
	renderingSpeed?: "turbo" | "balanced" | "quality";
}

export type VideoQualityTier =
	| "480p"
	| "580p"
	| "720p"
	| "768p"
	| "1080p"
	| "4k";

export type VideoMultishotMode = "off" | "extend" | "native";

export interface MotionControlCapability {
	characterOrientations?: Array<"video" | "image">;
	defaultCharacterOrientation?: "video" | "image";
	backgroundSources?: Array<"video" | "image">;
	defaultBackgroundSource?: "video" | "image";
	modeValueByResolution?: Record<string, string>;
	animateModes?: Array<{
		value: string;
		label?: string;
		modelId: string;
	}>;
	defaultAnimateMode?: string;
	supportsPrompt?: boolean;
}

export interface VideoCapabilities {
	startFrame?: boolean;
	endFrame?: boolean;
	multishot?: {
		mode: VideoMultishotMode;
		maxShots?: number;
		minShotDuration?: number;
		maxShotDuration?: number;
		maxTotalDuration?: number;
	};
	characterRef?: boolean;
	motionControl?: boolean;
	motionControlSettings?: MotionControlCapability;
	refVideo?: boolean;
	qualityTiers?: VideoQualityTier[];
	elements?: {
		max: number;
		minImagesPerElement: number;
		maxImagesPerElement: number;
	};
	referenceVideo?: {
		minImages: number;
		maxImages: number;
	};
	promptEnhance?: boolean;
	vibeMode?: {
		modes: string[];
		defaultMode: string;
	};
	nsfwFiltered?: boolean;
	multimodalReference?: {
		images?: { maxItems: number; maxFileSizeMB?: number };
		videos?: {
			maxItems: number;
			maxDurationSeconds?: number;
			maxFileSizeMB?: number;
		};
		audios?: {
			maxItems: number;
			maxDurationSeconds?: number;
			maxFileSizeMB?: number;
		};
	};
	audioToggle?: boolean;
}

export type NodeTypeCapability =
	| "text"
	| "image_gen"
	| "video_gen"
	| "copy_gen"
	| "image_upscale"
	| "image_upload"
	| "video_upload"
	| "image_bg_remove"
	| "video_upscale"
	| "variations"
	| "scene_planner";

export interface AIModelConfig {
	id: string;
	name: string;
	category: AIModelCategory;
	inputType: AIInputType;
	nodeTypes: NodeTypeCapability[];
	creditsPerUnit: number;
	creditUnit: AICreditUnit;
	maxDuration?: number;
	minDuration?: number;
	durationOptions?: number[];
	supportedResolutions?: string[];
	supportedAspectRatios?: string[];
	maxInputImages?: number;
	isDefault?: boolean;
	endpoint?: string;
	runtimePricingTiers?: AIRuntimePricingTier[];
	videoCapabilities?: VideoCapabilities;
	isNew?: boolean;
	addedAt?: number;
	tierRequired?: "starter" | "pro";
	provider?: string;
	/**
	 * The provider's own rate, when it has been verified. Left unset rather than
	 * guessed: an invented price is worse than a visible gap.
	 */
	pricing?: {
		unit: BillingUnit;
		/** Flat rate, used when the resolution is unknown or not priced apart. */
		usdPerUnit: number;
		/** Rates that differ by resolution, which most video vendors do. */
		byResolution?: Record<string, number>;
	};
	description?: string;
}
