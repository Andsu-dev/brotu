import type { AIModelConfig } from "./constants/model.types";
import type { S3StorageConfig } from "./lib/storage";
import type { WebhookConfig } from "./lib/webhook";

export interface ProviderConfig {
	apiKey: string;
	/** Defaults to the known base URL for the provider, when there is one. */
	baseUrl?: string;
}

export interface ReferenceVideoInfo {
	durationSeconds?: number;
	width?: number;
	height?: number;
}

export interface BrotuAIOptions {
	/**
	 * Your Brotu key (`brotu_sk_…`), from https://brotu.app.
	 * Vendor keys below generate on the vendor; everything else generates on Brotu.
	 */
	apiKey: string;
	/** Brotu API origin. Defaults to `https://api.brotu.app`. */
	apiUrl?: string;
	/**
	 * Workspace billed on Brotu generations. Resolved via
	 * `GET /studio/default-workspace` when omitted.
	 */
	workspaceId?: string;
	/** Vendor keys you already have. Those models generate on the vendor. */
	providers?: Record<string, ProviderConfig>;
	/** Provider used by catalog entries that do not declare one. Defaults to "kie". */
	defaultProvider?: string;
	/**
	 * Turn a private reference URL into one the provider can fetch.
	 * ponytail: identity by default — the SDK has no storage of its own.
	 */
	resolveUrl?: (url: string) => Promise<string>;
	/**
	 * Read duration/dimensions off a reference video. Only reference-video billing
	 * needs it; without it those models bill at their declared default.
	 * ponytail: undefined by default, wire ffmpeg here if you need exact billing.
	 */
	probeVideo?: (url: string) => Promise<ReferenceVideoInfo>;
	/**
	 * An S3-compatible bucket of your own. Configure it and the SDK uploads
	 * references for you and copies finished outputs off the providers' expiring
	 * URLs. `uploadImage` below is derived from it unless you pass your own.
	 */
	storage?: S3StorageConfig;
	/**
	 * Store a buffer and return a URL the provider can fetch. Overrides `storage`.
	 * Only reference-image cropping needs it; without either, cropping is skipped.
	 */
	uploadImage?: (
		buffer: Buffer,
		filename: string,
		mimeType: string,
	) => Promise<string>;
	/**
	 * Voice used when an ElevenLabs request names none. Their API has no default
	 * voice, and ids are account-specific — `listVoices()` on the adapter finds
	 * yours.
	 */
	elevenLabsVoiceId?: string;
	/** Extra models, or overrides of built-in ones, merged by id. */
	models?: AIModelConfig[];
	/**
	 * URL (or `{ url, secret }`) the client POSTs when a generation settles.
	 * Fires from `generate`, `jobs.wait`, and a terminal `jobs.poll`. Change it
	 * later with `ai.webhook.set`. A per-request `webhook` on the params wins.
	 */
	webhook?: string | WebhookConfig;
}

/** Resolved per-request routing: which host and key serve this model. */
export interface ResolvedProvider {
	id: string;
	apiKey: string;
	baseUrl: string;
}
