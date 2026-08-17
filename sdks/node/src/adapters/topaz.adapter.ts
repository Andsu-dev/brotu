import {
	isPendingJob,
	isSubmitMode,
	type Job,
	type JobSnapshot,
	PendingJob,
} from "../lib/jobs";
import {
	type AudioGenerationParams,
	type ContentGeneratorPort,
	type CostEstimate,
	expiresInHours,
	type GenerationOutput,
	type GenerationParams,
	type GenerationResult,
	type GenerationType,
	type ImageGenerationParams,
	type TextGenerationParams,
	type VideoGenerationParams,
} from "../ports/content-generator.port";
import {
	TOPAZ_CATALOG,
	TOPAZ_MODELS,
	type TopazBinding,
} from "../providers/topaz.models";
import { estimateFor } from "./estimate";

export interface TopazAdapterOptions {
	apiKey: string;
	baseUrl?: string;
	maxPollAttempts?: number;
}

const DEFAULT_BASE_URL = "https://api.topazlabs.com";
const POLL_INTERVAL_MS = 5000;
const DEFAULT_MAX_POLL_ATTEMPTS = 240;
const DEFAULT_FPS = 30;

const PIXELS: Record<string, { width: number; height: number }> = {
	"720p": { width: 1280, height: 720 },
	"720P": { width: 1280, height: 720 },
	"1080p": { width: 1920, height: 1080 },
	"1080P": { width: 1920, height: 1080 },
	"4k": { width: 3840, height: 2160 },
	"4K": { width: 3840, height: 2160 },
	"1K": { width: 1024, height: 1024 },
	"2K": { width: 2048, height: 2048 },
};

interface ExpressResponse {
	requestId?: string;
	uploadId?: string;
	uploadUrls?: string[];
	message?: string;
}

interface StatusResponse {
	status?: string;
	progress?: number;
	message?: string;
	outputSize?: string;
	estimates?: { cost?: number[]; time?: number[] };
	download?: { url?: string; expiresIn?: number; expiresAt?: number };
}

interface ImageStatusResponse {
	process_id?: string;
	status?: string;
	progress?: number;
	download_url?: string;
	eta?: number;
	model?: string;
	credits?: number;
}

interface ImageDownloadResponse {
	download_url?: string;
	expiry?: number;
}

/**
 * Topaz Labs video API.
 *
 * The express endpoint skips source probing and multi-part accept/complete:
 * create the request, PUT the file at the signed URL, then poll /status.
 * Auth is `X-API-Key`, not Bearer.
 */
export class TopazAdapter implements ContentGeneratorPort {
	readonly providerName = "topaz";
	readonly supportedTypes: GenerationType[] = ["video", "image"];

	private readonly opts: TopazAdapterOptions;

	constructor(opts: TopazAdapterOptions) {
		this.opts = opts;
	}

	private get baseUrl(): string {
		return (this.opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
	}

	private get headers(): Record<string, string> {
		return {
			"X-API-Key": this.opts.apiKey,
			accept: "application/json",
			"Content-Type": "application/json",
		};
	}

	private binding(modelId: string | undefined): [string, TopazBinding] {
		const id = modelId ?? "";
		const found = TOPAZ_MODELS[id];
		if (!found) {
			throw new Error(
				`"${id}" is not a Topaz model. Known: ${TOPAZ_CATALOG.map((model) => model.id).join(", ")}.`,
			);
		}
		return [id, found];
	}

	/** 720p / 1080p / 4k, or an explicit "1920x1080" / "1920*1080" pair. */
	resolutionOf(resolution: string | undefined): {
		width: number;
		height: number;
	} {
		if (!resolution) return PIXELS["1080p"] as { width: number; height: number };
		const named = PIXELS[resolution];
		if (named) return named;
		const match = /^(\d{2,5})[x*](\d{2,5})$/i.exec(resolution.trim());
		if (match?.[1] && match[2]) {
			return { width: Number(match[1]), height: Number(match[2]) };
		}
		throw new Error(
			`Topaz wants 720p, 1080p, 4k or WxH, not "${resolution}".`,
		);
	}

	containerOf(url: string): "mp4" | "mov" | "mkv" {
		const path = url.split("?")[0]?.toLowerCase() ?? "";
		if (path.endsWith(".mov")) return "mov";
		if (path.endsWith(".mkv")) return "mkv";
		return "mp4";
	}

	filterOf(
		binding: TopazBinding,
		params: VideoGenerationParams,
	): Record<string, unknown> {
		const extras = params.providerOptions?.topaz ?? {};
		if (binding.kind === "upscale") {
			return { auto: "Auto", ...extras, model: binding.vendorModel };
		}

		const slowmo = numberish(extras.slowmo) ?? 1;
		const fps = numberish(extras.fps) ?? DEFAULT_FPS;
		if (slowmo < 1 || slowmo > 16) {
			throw new Error(`Topaz interpolation slowmo is 1–16, not ${slowmo}.`);
		}
		if (fps < 15 || fps > 240) {
			throw new Error(`Topaz interpolation fps is 15–240, not ${fps}.`);
		}

		const filter: Record<string, unknown> = {
			model: binding.vendorModel,
			slowmo,
			fps,
		};
		if (typeof extras.duplicate === "boolean") {
			filter.duplicate = extras.duplicate;
		}
		if (extras.duplicateThreshold !== undefined) {
			filter.duplicateThreshold = extras.duplicateThreshold;
		}
		return filter;
	}

	requestBody(
		binding: TopazBinding,
		params: VideoGenerationParams,
		sourceUrl: string,
	): Record<string, unknown> {
		const extras = params.providerOptions?.topaz ?? {};
		const fps = numberish(extras.fps) ?? DEFAULT_FPS;
		return {
			source: { container: this.containerOf(sourceUrl) },
			filters: [this.filterOf(binding, params)],
			output: {
				resolution: this.resolutionOf(params.resolution),
				frameRate: fps,
				audioCodec: "AAC",
				audioTransfer: "Copy",
				dynamicCompressionLevel: "High",
				container: "mp4",
			},
		};
	}

	private async request<T>(
		path: string,
		init?: { method: "POST" | "GET"; body?: unknown },
	): Promise<T> {
		const response = await fetch(`${this.baseUrl}${path}`, {
			method: init?.method ?? "GET",
			headers: this.headers,
			body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
		});
		const payload = (await response.json()) as T & { message?: string };
		if (!response.ok) {
			throw new Error(
				payload.message ?? `Topaz returned ${response.status} for ${path}.`,
			);
		}
		return payload;
	}

	private async downloadSource(
		url: string,
	): Promise<{ bytes: ArrayBuffer; contentType: string }> {
		const response = await fetch(url);
		if (!response.ok) {
			throw new Error(`Could not download the source video (${response.status}).`);
		}
		return {
			bytes: await response.arrayBuffer(),
			contentType: response.headers.get("content-type") ?? "video/mp4",
		};
	}

	private async submitTask(
		params: VideoGenerationParams,
	): Promise<{ taskId: string; pollEndpoint: string }> {
		const [, binding] = this.binding(params.model);
		if (binding.surface !== "video") {
			throw new Error(
				`Topaz "${params.model}" is an image model. Use ai.image.`,
			);
		}
		const sourceUrl = params.videoUrl ?? params.videoUrls?.[0];
		if (!sourceUrl) {
			throw new Error(
				`Topaz "${params.model}" needs a source video — pass videoUrl.`,
			);
		}

		const source = await this.downloadSource(sourceUrl);
		const created = await this.request<ExpressResponse>("/video/express", {
			method: "POST",
			body: this.requestBody(binding, params, sourceUrl),
		});
		const taskId = created.requestId?.trim();
		const uploadUrl = created.uploadUrls?.[0];
		if (!taskId || !uploadUrl) {
			throw new Error(
				"Topaz accepted the request but returned no request id or upload URL.",
			);
		}

		// The signed URL is S3. Extra auth headers make the signature fail.
		const uploaded = await fetch(uploadUrl, {
			method: "PUT",
			headers: { "Content-Type": source.contentType },
			body: source.bytes,
		});
		if (!uploaded.ok) {
			throw new Error(`Topaz upload failed (${uploaded.status}).`);
		}

		return { taskId, pollEndpoint: `/video/${taskId}/status` };
	}

	outputsFrom(payload: StatusResponse, job: Job): GenerationOutput[] {
		const url = payload.download?.url;
		if (!url) return [];
		const expiresAtMs = payload.download?.expiresAt;
		return [
			{
				url,
				mimeType: "video/mp4",
				taskId: job.id,
				expiresAt: expiresAtMs
					? new Date(expiresAtMs).toISOString()
					: expiresInHours(24),
				raw: {
					status: payload.status,
					progress: payload.progress,
					estimates: payload.estimates,
					outputSize: payload.outputSize,
				},
			},
		];
	}

	private snapshot(payload: StatusResponse, job: Job): JobSnapshot {
		const raw = (payload.status ?? "").toLowerCase();
		if (raw === "failed" || raw === "canceled") {
			return {
				status: "failed",
				error: payload.message ?? `Topaz request ${raw}.`,
			};
		}
		if (raw !== "complete") return { status: "pending" };

		const outputs = this.outputsFrom(payload, job);
		if (outputs.length === 0) return { status: "pending" };

		return {
			status: "succeeded",
			result: {
				success: true,
				outputs,
				creditsUsed: 0,
				provider: this.providerName,
				model: job.model,
				processingTimeMs: 0,
			},
		};
	}

	private async run(params: VideoGenerationParams): Promise<GenerationResult> {
		const startedAt = Date.now();
		let modelId = params.model ?? "(none)";

		const failure = (error: string): GenerationResult => ({
			success: false,
			outputs: [],
			creditsUsed: 0,
			provider: this.providerName,
			model: modelId,
			processingTimeMs: Date.now() - startedAt,
			error,
		});

		let submitted: { taskId: string; pollEndpoint: string };
		try {
			modelId = this.binding(params.model)[0];
			submitted = await this.submitTask(params);
		} catch (error) {
			if (isPendingJob(error)) throw error;
			return failure(error instanceof Error ? error.message : String(error));
		}

		if (isSubmitMode()) {
			throw new PendingJob(submitted.taskId, submitted.pollEndpoint);
		}

		const job: Job = {
			id: submitted.taskId,
			provider: this.providerName,
			model: modelId,
			kind: "video",
			pollEndpoint: submitted.pollEndpoint,
			params,
			submittedAt: new Date(startedAt).toISOString(),
		};

		const maxAttempts = this.opts.maxPollAttempts ?? DEFAULT_MAX_POLL_ATTEMPTS;
		for (let attempt = 0; attempt < maxAttempts; attempt++) {
			const snapshot = await this.completeJob(job);
			if (snapshot.status === "failed") {
				return failure(snapshot.error ?? "Topaz request failed.");
			}
			if (snapshot.status === "succeeded" && snapshot.result) {
				return { ...snapshot.result, processingTimeMs: Date.now() - startedAt };
			}
			await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
		}

		return failure(
			`Topaz request ${submitted.taskId} did not finish after ${maxAttempts} checks.`,
		);
	}

	async completeJob(job: Job): Promise<JobSnapshot> {
		try {
			if (job.pollEndpoint?.startsWith("/image/")) {
				return this.imageSnapshot(job);
			}
			const payload = await this.request<StatusResponse>(
				job.pollEndpoint ?? `/video/${job.id}/status`,
			);
			return this.snapshot(payload, job);
		} catch (error) {
			return {
				status: "failed",
				error: error instanceof Error ? error.message : String(error),
			};
		}
	}

	generateVideo(params: VideoGenerationParams): Promise<GenerationResult> {
		return this.run(params);
	}

	imageBody(
		binding: TopazBinding,
		params: ImageGenerationParams,
		sourceUrl: string,
	): Record<string, string> {
		const extras = params.providerOptions?.topaz ?? {};
		const pixels = params.resolution
			? this.resolutionOf(params.resolution)
			: undefined;
		const fields: Record<string, string> = {
			source_url: sourceUrl,
			model: binding.vendorModel,
			output_format:
				params.outputFormat === "png"
					? "png"
					: params.outputFormat === "jpeg"
						? "jpeg"
						: "jpeg",
		};
		if (pixels) {
			fields.output_width = String(pixels.width);
			fields.output_height = String(pixels.height);
		}
		for (const [key, value] of Object.entries(extras)) {
			if (value === undefined) continue;
			fields[key] = typeof value === "string" ? value : String(value);
		}
		return fields;
	}

	private async submitImage(
		params: ImageGenerationParams,
	): Promise<{ taskId: string; pollEndpoint: string }> {
		const [, binding] = this.binding(params.model);
		if (binding.surface !== "image" || !binding.imagePath) {
			throw new Error(
				`Topaz "${params.model}" is a video model. Use ai.video with videoUrl.`,
			);
		}
		const sourceUrl = params.referenceImages?.[0];
		if (!sourceUrl) {
			throw new Error(
				`Topaz "${params.model}" needs a source image — pass referenceImages.`,
			);
		}

		const form = new FormData();
		for (const [key, value] of Object.entries(
			this.imageBody(binding, params, sourceUrl),
		)) {
			form.set(key, value);
		}

		const response = await fetch(`${this.baseUrl}${binding.imagePath}`, {
			method: "POST",
			headers: {
				"X-API-Key": this.opts.apiKey,
				accept: "application/json",
			},
			body: form,
		});
		const payload = (await response.json()) as {
			process_id?: string;
			message?: string;
		};
		if (!response.ok) {
			throw new Error(
				payload.message ?? `Topaz returned ${response.status} enhancing the image.`,
			);
		}
		const taskId = payload.process_id?.trim();
		if (!taskId) {
			throw new Error(
				"Topaz accepted the image but returned no process id.",
			);
		}
		return { taskId, pollEndpoint: `/image/v1/status/${taskId}` };
	}

	private async imageSnapshot(job: Job): Promise<JobSnapshot> {
		const payload = await this.request<ImageStatusResponse>(
			job.pollEndpoint ?? `/image/v1/status/${job.id}`,
		);
		const raw = (payload.status ?? "").toLowerCase();
		if (raw === "failed" || raw === "cancelled") {
			return {
				status: "failed",
				error: `Topaz image ${raw}.`,
			};
		}
		if (raw !== "completed") return { status: "pending" };

		let url = payload.download_url;
		let expiresAt = payload.eta
			? new Date((payload.eta > 10_000_000_000 ? payload.eta : payload.eta * 1000)).toISOString()
			: undefined;
		if (!url) {
			const download = await this.request<ImageDownloadResponse>(
				`/image/v1/download/${job.id}`,
			);
			url = download.download_url;
			if (download.expiry) {
				expiresAt = new Date(
					download.expiry > 10_000_000_000
						? download.expiry
						: download.expiry * 1000,
				).toISOString();
			}
		}
		if (!url) return { status: "pending" };

		return {
			status: "succeeded",
			result: {
				success: true,
				outputs: [
					{
						url,
						mimeType: "image/jpeg",
						taskId: job.id,
						expiresAt: expiresAt ?? expiresInHours(1),
						raw: {
							status: payload.status,
							progress: payload.progress,
							model: payload.model,
						},
					},
				],
				creditsUsed: payload.credits ?? 0,
				provider: this.providerName,
				model: job.model,
				processingTimeMs: 0,
			},
		};
	}

	private async runImage(
		params: ImageGenerationParams,
	): Promise<GenerationResult> {
		const startedAt = Date.now();
		let modelId = params.model ?? "(none)";
		const failure = (error: string): GenerationResult => ({
			success: false,
			outputs: [],
			creditsUsed: 0,
			provider: this.providerName,
			model: modelId,
			processingTimeMs: Date.now() - startedAt,
			error,
		});

		let submitted: { taskId: string; pollEndpoint: string };
		try {
			modelId = this.binding(params.model)[0];
			submitted = await this.submitImage(params);
		} catch (error) {
			if (isPendingJob(error)) throw error;
			return failure(error instanceof Error ? error.message : String(error));
		}

		if (isSubmitMode()) {
			throw new PendingJob(submitted.taskId, submitted.pollEndpoint);
		}

		const job: Job = {
			id: submitted.taskId,
			provider: this.providerName,
			model: modelId,
			kind: "image",
			pollEndpoint: submitted.pollEndpoint,
			params,
			submittedAt: new Date(startedAt).toISOString(),
		};

		const maxAttempts = this.opts.maxPollAttempts ?? DEFAULT_MAX_POLL_ATTEMPTS;
		for (let attempt = 0; attempt < maxAttempts; attempt++) {
			const snapshot = await this.completeJob(job);
			if (snapshot.status === "failed") {
				return failure(snapshot.error ?? "Topaz image failed.");
			}
			if (snapshot.status === "succeeded" && snapshot.result) {
				return { ...snapshot.result, processingTimeMs: Date.now() - startedAt };
			}
			await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
		}

		return failure(
			`Topaz image ${submitted.taskId} did not finish after ${maxAttempts} checks.`,
		);
	}

	generateImage(params: ImageGenerationParams): Promise<GenerationResult> {
		return this.runImage(params);
	}

	generateText(params: TextGenerationParams): Promise<GenerationResult> {
		return Promise.resolve(unsupported(this.providerName, params.model, "text"));
	}

	generateAudio(params: AudioGenerationParams): Promise<GenerationResult> {
		return Promise.resolve(unsupported(this.providerName, params.model, "audio"));
	}

	estimateCost(
		type: GenerationType,
		params: GenerationParams,
	): Promise<CostEstimate> {
		return Promise.resolve(estimateFor(this.providerName, type, params));
	}

	supportsModel(model: string): boolean {
		return model in TOPAZ_MODELS;
	}

	getAvailableModels(): { id: string; name: string; type: GenerationType }[] {
		return TOPAZ_CATALOG.map((model) => ({
			id: model.id,
			name: model.name,
			type: model.category,
		}));
	}
}

function numberish(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.length > 0) {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : undefined;
	}
	return undefined;
}

function unsupported(
	provider: string,
	model: string | undefined,
	kind: GenerationType,
): GenerationResult {
	return {
		success: false,
		outputs: [],
		creditsUsed: 0,
		provider,
		model: model ?? "",
		processingTimeMs: 0,
		error: `Topaz does not generate ${kind} on this adapter.`,
	};
}
