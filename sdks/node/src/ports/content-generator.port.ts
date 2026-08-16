import type { BillingUnit } from "../constants/model.types";

/** Known values, kept open because providers disagree on spelling and units. */
export type VideoResolution =
	| "480p"
	| "580p"
	| "720p"
	| "768p"
	| "1080p"
	| "4k"
	| "480P"
	| "720P"
	| "1080P"
	// Keeps the union open without losing autocomplete on the known values.
	| (string & {});

export type ImageResolution =
	| "1K"
	| "2K"
	| "4K"
	// Keeps the union open without losing autocomplete on the known values.
	| (string & {});

/**
 * Content Generator Port - Interface for AI content generation providers
 * Implements hexagonal architecture pattern for provider abstraction
 */

export type GenerationType = "image" | "video" | "text" | "audio";

/** What every generation call accepts, whatever it produces. */
export interface CommonGenerationParams {
	prompt: string;
	model?: string;
	/**
	 * Your own tags, carried through untouched and handed back on the job and the
	 * result. Never sent to the provider — it is for correlating a generation
	 * with whatever it belongs to on your side: a user, a campaign, a job queue.
	 */
	metadata?: Record<string, string>;
	/**
	 * Fields merged straight into the provider's request body, keyed by provider
	 * name. The escape hatch for anything the shared params cannot express; it
	 * overrides what the adapter would otherwise send.
	 */
	providerOptions?: Record<string, Record<string, unknown>>;
}

/**
 * Shared image parameters.
 *
 * Only fields at least one adapter reads live here. A field nothing sends is
 * worse than a missing one: it reads as supported and silently does nothing.
 * Anything one vendor alone understands goes in `providerOptions`.
 */
export interface ImageGenerationParams extends CommonGenerationParams {
	negativePrompt?: string;
	/**
	 * Providers disagree on spelling and units: "1K"/"2K"/"4K" on Seedream and
	 * wan2.7-image, "1024*1024" pixel pairs elsewhere. The union is for
	 * autocomplete; any string is accepted and the adapter validates it against
	 * the model's own list.
	 */
	resolution?: ImageResolution;
	aspectRatio?:
		| "1:1"
		| "3:4"
		| "4:3"
		| "4:5"
		| "5:4"
		| "9:16"
		| "16:9"
		| "21:9"
		| "auto"
		// Kept open: providers keep adding ratios.
		| (string & {});
	outputFormat?: "png" | "jpeg";
	/**
	 * Quality tier, where the provider has one. On OpenAI this moves the price by
	 * more than 30x, so the adapter pins it rather than letting the API choose.
	 */
	quality?: "low" | "medium" | "high";
	seed?: number;
	/** Reference images, cited positionally by most providers. */
	referenceImages?: string[];
}

/**
 * Shared video parameters. Same rule as images: nothing here that no adapter
 * reads. Vendor-specific inputs live behind `ai.<provider>.*` capabilities or
 * in `providerOptions`.
 */
export interface VideoGenerationParams extends CommonGenerationParams {
	negativePrompt?: string;
	/** Seconds. Which values are legal is per-model; see CATALOG.md. */
	duration?: number;
	/**
	 * Kling and Seedance spell these lowercase, Qwen uppercase, and wan2.6 wants
	 * a "1280*720" pixel pair instead. The union is for autocomplete; any string
	 * is accepted and the adapter validates it against the model's own list.
	 */
	resolution?: VideoResolution;
	aspectRatio?:
		| "1:1"
		| "3:4"
		| "4:3"
		| "4:5"
		| "5:4"
		| "9:16"
		| "16:9"
		| "21:9"
		| "auto"
		// Kept open: providers keep adding ratios.
		| (string & {});
	/** Quality tier, where the provider has one. */
	mode?: "std" | "pro";
	/** Ask for an audio track on models that can produce one. */
	withAudio?: boolean;
	seed?: number;
	/** First frame, for image-to-video. */
	imageUrl?: string;
	/** Reference images. Index 0 is the first frame, index 1 the last, where supported. */
	referenceImages?: string[];
	/** Several references at once, for reference-to-video models. */
	imageUrls?: string[];
	/** Source video, for editing and continuation. */
	videoUrl?: string;
	videoUrls?: string[];
}

export interface TextGenerationParams extends CommonGenerationParams {
	systemPrompt?: string;
	maxTokens?: number;
	temperature?: number;
	topP?: number;
	referenceImages?: string[]; // URLs of reference images for multimodal vision models
}

/** Speech synthesis. `prompt` is the text to speak. */
export interface AudioGenerationParams extends CommonGenerationParams {
	/** Provider-specific voice name; see the model's entry in CATALOG.md. */
	voice?: string;
	outputFormat?: "mp3" | "wav" | "pcm";
	/** Playback rate, where the provider supports it. */
	speed?: number;
	language?: string;
}

export type GenerationParams =
	| ImageGenerationParams
	| VideoGenerationParams
	| TextGenerationParams
	| AudioGenerationParams;

/**
 * One produced file. The named fields are the ones every provider can answer;
 * anything a single vendor reports and the others do not goes in `raw`, so the
 * shape does not drift as providers are added.
 */
export interface GenerationOutput {
	url: string;
	mimeType: string;
	/** The provider's own id for the task that produced this. */
	taskId?: string;
	/** Video length in seconds, when the provider reports it. */
	durationSeconds?: number;
	/** Bytes, when the provider reports it. Most do not. */
	sizeBytes?: number;
	/**
	 * When the provider's URL stops working, as an ISO timestamp. Every provider
	 * hands back a presigned link, so copy the file before this passes — or give
	 * the client a `storage` bucket and it copies for you.
	 */
	expiresAt?: string;
	/** Set once the output has been copied into your own bucket. */
	sourceUrl?: string;
	/** Whatever this provider reports that has no shared name. */
	raw?: Record<string, unknown>;
}

/** Handy for adapters: an ISO stamp N hours from now. */
export function expiresInHours(hours: number): string {
	return new Date(Date.now() + hours * 3600_000).toISOString();
}

export interface GenerationResult {
	success: boolean;
	outputs: GenerationOutput[];
	creditsUsed: number;
	provider: string;
	model: string;
	processingTimeMs: number;
	error?: string;
}

/** What a generation will be billed for. */
export interface CostEstimate {
	/** What the provider counts. */
	unit: BillingUnit;
	/** How many of them this request will use. */
	units: number;
	/**
	 * Price in USD, or null when this model has no verified rate in the catalog.
	 * Null rather than zero on purpose: a made-up number is worse than an honest
	 * gap, and zero reads as free.
	 */
	usd: number | null;
	/** What the price depends on, or why it is unknown. */
	note?: string;
	provider: string;
	model: string;
}

export interface ContentGeneratorPort {
	readonly providerName: string;
	readonly supportedTypes: GenerationType[];

	generateImage(params: ImageGenerationParams): Promise<GenerationResult>;
	generateVideo(params: VideoGenerationParams): Promise<GenerationResult>;
	generateText(params: TextGenerationParams): Promise<GenerationResult>;
	generateAudio(params: AudioGenerationParams): Promise<GenerationResult>;

	estimateCost(
		type: GenerationType,
		params: GenerationParams,
	): Promise<CostEstimate>;

	supportsModel(model: string): boolean;
	getAvailableModels(): { id: string; name: string; type: GenerationType }[];
}
