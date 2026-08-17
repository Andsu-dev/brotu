import { BROTU_SUPPORTED_CATEGORIES } from "../catalog";
import {
	isSubmitMode,
	type Job,
	type JobSnapshot,
	PendingJob,
} from "../lib/jobs";
import {
	type AudioGenerationParams,
	type ContentGeneratorPort,
	type CostEstimate,
	type GenerationOutput,
	type GenerationParams,
	type GenerationResult,
	type GenerationType,
	type ImageGenerationParams,
	type TextGenerationParams,
	type VideoGenerationParams,
} from "../ports/content-generator.port";
import { estimateFor } from "./estimate";

export interface BrotuAdapterOptions {
	apiKey: string;
	/** Origin only, no trailing slash. Defaults to https://api.brotu.app */
	apiUrl?: string;
	workspaceId?: string;
	maxPollAttempts?: number;
}

const DEFAULT_API_URL = "https://api.brotu.app";
const POLL_INTERVAL_MS = 3000;
const DEFAULT_MAX_POLL_ATTEMPTS = 400;

/**
 * SDK catalog ids that do not match the platform catalog. Unlisted ids are
 * sent as-is — gpt-image-2 and bytedance/seedance-2-5 already agree.
 */
const PLATFORM_MODEL_IDS: Record<string, string> = {
	"kling/v2-6": "kling-2.6",
	"kling/v3": "kling-3.0/video",
	"dreamina-seedance-2-5-260628": "bytedance/seedance-2-5",
	"dreamina-seedance-2-0-260128": "bytedance/seedance-2",
	"dreamina-seedance-2-0-fast-260128": "bytedance/seedance-2-fast",
	"gpt-image-1.5": "gpt-image/1.5",
};

interface PlatformErrorBody {
	error?: { message?: string; status?: number };
	message?: string;
}

interface PlatformGeneration {
	generationId?: string;
	status?: string;
	creditsUsed?: number | null;
	errorMessage?: string | null;
	outputs?: {
		images?: string[];
		videos?: string[];
		copies?: string[];
	} | null;
	metadata?: Record<string, unknown> | null;
}

const UNSUPPORTED_VIA_CREDITS =
	"Speech and text generate on the vendor. Pass that provider's key.";

export class BrotuAdapter implements ContentGeneratorPort {
	readonly providerName = "brotu";
	readonly supportedTypes: GenerationType[] = BROTU_SUPPORTED_CATEGORIES;

	private workspaceIdCache?: string;

	constructor(private readonly opts: BrotuAdapterOptions) {}

	private get origin(): string {
		return (this.opts.apiUrl ?? DEFAULT_API_URL).replace(/\/$/, "");
	}

	private headers(): Record<string, string> {
		return {
			Authorization: `Bearer ${this.opts.apiKey}`,
			"Content-Type": "application/json",
		};
	}

	private async workspaceId(): Promise<string> {
		if (this.opts.workspaceId) return this.opts.workspaceId;
		if (this.workspaceIdCache) return this.workspaceIdCache;

		const payload = await this.request<{
			workspaceId?: string;
		}>("/api/v1/studio/default-workspace");
		const id = payload.workspaceId?.trim();
		if (!id) {
			throw new Error(
				"This Brotu account has no workspace. Open https://brotu.app and create one.",
			);
		}
		this.workspaceIdCache = id;
		return id;
	}

	private studioPath(path: string, workspaceId: string): string {
		const joiner = path.includes("?") ? "&" : "?";
		return `${path}${joiner}workspaceId=${encodeURIComponent(workspaceId)}`;
	}

	private async request<T>(path: string, init?: RequestInit): Promise<T> {
		const response = await fetch(`${this.origin}${path}`, {
			...init,
			headers: { ...this.headers(), ...init?.headers },
		});
		const text = await response.text();
		let body: unknown = undefined;
		if (text) {
			try {
				body = JSON.parse(text) as unknown;
			} catch {
				body = text;
			}
		}
		if (!response.ok) {
			const parsed = body as PlatformErrorBody | undefined;
			const message =
				parsed && typeof parsed === "object"
					? parsed.error?.message || parsed.message || text
					: text;
			throw new Error(message || `Brotu API ${response.status}`);
		}
		return body as T;
	}

	private platformModel(modelId: string): string {
		return PLATFORM_MODEL_IDS[modelId] ?? modelId;
	}

	private async startGeneration(
		kind: "image" | "video",
		params: ImageGenerationParams | VideoGenerationParams,
	): Promise<{ generationId: string; workspaceId: string }> {
		const modelId = params.model ?? "";
		const workspaceId = await this.workspaceId();
		const path =
			kind === "video" ? "/api/v1/studio/videos" : "/api/v1/studio/images";
		const body =
			kind === "video"
				? this.videoBody(params as VideoGenerationParams, modelId)
				: this.imageBody(params as ImageGenerationParams, modelId);

		const result = await this.request<{ generationId?: string }>(
			this.studioPath(path, workspaceId),
			{ method: "POST", body: JSON.stringify(body) },
		);
		const generationId = result.generationId?.trim();
		if (!generationId) {
			throw new Error("Brotu accepted the request but returned no generation id.");
		}
		return { generationId, workspaceId };
	}

	private imageBody(
		params: ImageGenerationParams,
		modelId: string,
	): Record<string, unknown> {
		return {
			prompt: params.prompt,
			model: this.platformModel(modelId),
			aspectRatio: params.aspectRatio,
			resolution: params.resolution,
			negativePrompt: params.negativePrompt,
			outputFormat: params.outputFormat,
			seed: params.seed,
			referenceImages: params.referenceImages,
		};
	}

	private videoBody(
		params: VideoGenerationParams,
		modelId: string,
	): Record<string, unknown> {
		return {
			prompt: params.prompt,
			model: this.platformModel(modelId),
			duration: params.duration,
			resolution: params.resolution,
			aspectRatio: params.aspectRatio,
			mode: params.mode,
			withAudio: params.withAudio,
			seed: params.seed,
			imageUrl: params.imageUrl,
			imageUrls: params.imageUrls,
			videoUrl: params.videoUrl,
			videoUrls: params.videoUrls,
			referenceImages: params.referenceImages,
		};
	}

	private async run(
		kind: "image" | "video",
		params: ImageGenerationParams | VideoGenerationParams,
	): Promise<GenerationResult> {
		const startedAt = Date.now();
		const modelId = params.model ?? "(none)";

		const failure = (error: string): GenerationResult => ({
			success: false,
			outputs: [],
			creditsUsed: 0,
			provider: this.providerName,
			model: modelId,
			processingTimeMs: Date.now() - startedAt,
			error,
		});

		let submitted: { generationId: string; workspaceId: string };
		try {
			submitted = await this.startGeneration(kind, params);
		} catch (error) {
			return failure(error instanceof Error ? error.message : String(error));
		}

		const pollEndpoint = this.studioPath(
			`/api/v1/studio/generations/${submitted.generationId}`,
			submitted.workspaceId,
		);

		if (isSubmitMode()) {
			throw new PendingJob(submitted.generationId, pollEndpoint);
		}

		const job: Job = {
			id: submitted.generationId,
			provider: this.providerName,
			model: modelId,
			kind,
			pollEndpoint,
			params,
			submittedAt: new Date(startedAt).toISOString(),
		};

		const maxAttempts = this.opts.maxPollAttempts ?? DEFAULT_MAX_POLL_ATTEMPTS;
		for (let attempt = 0; attempt < maxAttempts; attempt++) {
			const snapshot = await this.completeJob(job);
			if (snapshot.status === "failed") {
				return failure(snapshot.error ?? "Brotu generation failed.");
			}
			if (snapshot.status === "succeeded" && snapshot.result) {
				return { ...snapshot.result, processingTimeMs: Date.now() - startedAt };
			}
			await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
		}

		return failure(
			`Brotu generation ${submitted.generationId} did not finish after ${maxAttempts} checks.`,
		);
	}

	async completeJob(job: Job): Promise<JobSnapshot> {
		const workspaceId =
			this.workspaceFromPoll(job.pollEndpoint) ?? (await this.workspaceId());
		const path = this.studioPath(
			`/api/v1/studio/generations/${job.id}`,
			workspaceId,
		);
		const generation = await this.request<PlatformGeneration>(path);
		const status = (generation.status ?? "").toLowerCase();

		if (status === "failed") {
			return {
				status: "failed",
				error: generation.errorMessage ?? "Brotu generation failed.",
			};
		}
		if (status !== "completed") {
			return { status: "pending" };
		}

		const outputs = outputsFrom(generation, job.kind);
		return {
			status: "succeeded",
			result: {
				success: true,
				outputs,
				creditsUsed: generation.creditsUsed ?? 0,
				provider: this.providerName,
				model: job.model,
				processingTimeMs: 0,
			},
		};
	}

	private workspaceFromPoll(pollEndpoint?: string): string | undefined {
		if (!pollEndpoint) return undefined;
		try {
			const url = new URL(pollEndpoint, "https://brotu.invalid");
			return url.searchParams.get("workspaceId") ?? undefined;
		} catch {
			return undefined;
		}
	}

	generateImage(params: ImageGenerationParams): Promise<GenerationResult> {
		return this.run("image", params);
	}

	generateVideo(params: VideoGenerationParams): Promise<GenerationResult> {
		return this.run("video", params);
	}

	async generateText(params: TextGenerationParams): Promise<GenerationResult> {
		return {
			success: false,
			outputs: [],
			creditsUsed: 0,
			provider: this.providerName,
			model: params.model ?? "(none)",
			processingTimeMs: 0,
			error: UNSUPPORTED_VIA_CREDITS,
		};
	}

	async generateAudio(params: AudioGenerationParams): Promise<GenerationResult> {
		return {
			success: false,
			outputs: [],
			creditsUsed: 0,
			provider: this.providerName,
			model: params.model ?? "(none)",
			processingTimeMs: 0,
			error: UNSUPPORTED_VIA_CREDITS,
		};
	}

	async estimateCost(
		type: GenerationType,
		params: GenerationParams,
	): Promise<CostEstimate> {
		if (type === "audio" || type === "text") {
			const estimate = estimateFor(this.providerName, type, params);
			return {
				...estimate,
				usd: null,
				note: UNSUPPORTED_VIA_CREDITS,
			};
		}

		try {
			const workspaceId = await this.workspaceId();
			const video = params as VideoGenerationParams;
			const image = params as ImageGenerationParams;
			const payload = await this.request<{ estimatedCredits?: number }>(
				this.studioPath("/api/v1/studio/estimate", workspaceId),
				{
					method: "POST",
					body: JSON.stringify({
						model: this.platformModel(params.model ?? ""),
						duration: video.duration,
						resolution: video.resolution ?? image.resolution,
						aspectRatio: video.aspectRatio ?? image.aspectRatio,
						withAudio: video.withAudio,
						hasReferenceImage: Boolean(
							video.imageUrl ||
								video.imageUrls?.length ||
								video.referenceImages?.length ||
								image.referenceImages?.length,
						),
						hasReferenceVideo: Boolean(video.videoUrl || video.videoUrls?.length),
						quality: image.quality,
					}),
				},
			);
			const credits = payload.estimatedCredits ?? 0;
			return {
				unit: type === "video" ? "second" : "image",
				units: credits,
				usd: null,
				note: `${credits} Brotu credit${credits === 1 ? "" : "s"}. A vendor key generates on that provider.`,
				provider: this.providerName,
				model: params.model ?? "",
			};
		} catch (error) {
			const estimate = estimateFor(this.providerName, type, params);
			return {
				...estimate,
				usd: null,
				note:
					error instanceof Error
						? error.message
						: "Could not estimate Brotu credits.",
			};
		}
	}

	supportsModel(): boolean {
		return true;
	}

	getAvailableModels(): { id: string; name: string; type: GenerationType }[] {
		return [];
	}
}

function outputsFrom(
	generation: PlatformGeneration,
	kind: GenerationType,
): GenerationOutput[] {
	const bucket = generation.outputs;
	const urls =
		kind === "video"
			? (bucket?.videos ?? bucket?.images ?? [])
			: (bucket?.images ?? bucket?.videos ?? []);
	const copies = bucket?.copies ?? [];
	const mimeType = kind === "video" ? "video/mp4" : "image/png";

	const fromUrls = urls.filter(Boolean).map((url) => ({
		url,
		mimeType,
	}));
	if (fromUrls.length > 0) return fromUrls;

	return copies.filter(Boolean).map((url) => ({
		url,
		mimeType: "text/plain",
		raw: { text: url },
	}));
}

export { PLATFORM_MODEL_IDS };
