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
	BYTEPLUS_IMAGE_MODELS,
	BYTEPLUS_MODELS,
	type BytePlusModelBinding,
	fieldsFor,
} from "../providers/byteplus.models";
import { estimateFor } from "./estimate";

export interface BytePlusAdapterOptions {
	apiKey: string;
	baseUrl?: string;
	maxPollAttempts?: number;
}

// The global host. `ark.cn-beijing.volces.com` is Volcengine, a separate account
// system that rejects BytePlus keys outright — pass providers.byteplus.baseUrl.
const DEFAULT_BASE_URL = "https://ark.ap-southeast.bytepluses.com";
const TASKS_PATH = "/api/v3/contents/generations/tasks";
const IMAGES_PATH = "/api/v3/images/generations";
const POLL_INTERVAL_MS = 5000;
const DEFAULT_MAX_POLL_ATTEMPTS = 240;

interface ArkTask {
	id: string;
	status:
		| "queued"
		| "running"
		| "succeeded"
		| "failed"
		| "cancelled"
		| "expired";
	content?: { video_url?: string; last_frame_url?: string };
	error?: { code: string; message: string };
	usage?: { completion_tokens?: number; total_tokens?: number };
}

interface ArkImageResponse {
	model?: string;
	created?: number;
	data?: Array<{ url?: string; b64_json?: string; size?: string }>;
	usage?: { generated_images?: number; output_tokens?: number };
}

interface ArkError {
	error?: { code: string; message: string };
}

type ContentItem =
	| { type: "text"; text: string }
	| { type: "image_url"; image_url: { url: string }; role?: string };

/**
 * BytePlus ModelArk, home of Seedance.
 *
 * Two things drive the shape of this adapter. Ark 400s on any field the model
 * does not accept instead of ignoring it, so nothing is sent unless the caller
 * asked for it and the family allows it. And a result URL is valid for only 24
 * hours, so configure `storage` on the client unless you are consuming the video
 * immediately.
 */
export class BytePlusAdapter implements ContentGeneratorPort {
	readonly providerName = "byteplus";
	readonly supportedTypes: GenerationType[] = ["image", "video"];

	private readonly opts: BytePlusAdapterOptions;

	constructor(opts: BytePlusAdapterOptions) {
		this.opts = opts;
	}

	private get baseUrl(): string {
		return (this.opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
	}

	private async request<T>(
		path: string,
		init?: { method: "POST"; body: unknown },
	): Promise<T> {
		const response = await fetch(`${this.baseUrl}${path}`, {
			method: init?.method ?? "GET",
			headers: {
				Authorization: `Bearer ${this.opts.apiKey}`,
				"Content-Type": "application/json",
			},
			body: init ? JSON.stringify(init.body) : undefined,
		});

		const payload = (await response.json()) as T & ArkError;
		if (payload.error) {
			throw new Error(`${payload.error.code}: ${payload.error.message}`);
		}
		if (!response.ok) {
			throw new Error(`Ark returned ${response.status} for ${path}.`);
		}
		return payload;
	}

	private binding(modelId: string | undefined): [string, BytePlusModelBinding] {
		const id = modelId ?? "";
		const found = BYTEPLUS_MODELS[id];
		if (!found) {
			throw new Error(
				`"${id}" is not a BytePlus model. Known: ${Object.keys(BYTEPLUS_MODELS).join(", ")}.`,
			);
		}
		return [id, found];
	}

	private buildBody(
		modelId: string,
		binding: BytePlusModelBinding,
		params: VideoGenerationParams & ImageGenerationParams,
	): Record<string, unknown> {
		const content: ContentItem[] = [{ type: "text", text: params.prompt }];

		const firstFrame = params.imageUrl ?? params.referenceImages?.[0];
		const references = params.imageUrls ?? [];

		// First-frame, first+last-frame and reference modes are three mutually
		// exclusive task types; Ark rejects a request that mixes them.
		if (references.length > 0) {
			if (binding.referenceImages === 0) {
				throw new Error(
					`Seedance "${modelId}" takes no reference images — use imageUrl for a first frame.`,
				);
			}
			for (const url of references.slice(0, binding.referenceImages)) {
				content.push({
					type: "image_url",
					image_url: { url },
					role: "reference_image",
				});
			}
		} else if (firstFrame) {
			content.push({
				type: "image_url",
				image_url: { url: firstFrame },
				role: "first_frame",
			});
			const lastFrame = params.referenceImages?.[1];
			if (lastFrame) {
				if (!binding.lastFrame) {
					throw new Error(
						`Seedance "${modelId}" does not accept a last frame.`,
					);
				}
				content.push({
					type: "image_url",
					image_url: { url: lastFrame },
					role: "last_frame",
				});
			}
		}

		const allowed = fieldsFor(binding.family);
		const body: Record<string, unknown> = { model: modelId, content };

		// Always pinned: the 1.0-pro models default to 1080p, and tokens scale with
		// pixels, so omitting it silently bills at the top tier.
		body.resolution = params.resolution ?? binding.defaultResolution;

		if (params.aspectRatio && params.aspectRatio !== "auto") {
			body.ratio = params.aspectRatio;
		}
		if (params.duration !== undefined) body.duration = params.duration;
		if (allowed.seed && params.seed !== undefined) body.seed = params.seed;
		if (allowed.generateAudio && params.withAudio !== undefined) {
			// 2.x and 1.5 default this to true, so silence has to be asked for.
			body.generate_audio = params.withAudio;
		}

		// The caller's escape hatch wins, since they asked for it by name.
		return { ...body, ...(params.providerOptions?.byteplus ?? {}) };
	}

	private validate(
		modelId: string,
		binding: BytePlusModelBinding,
		kind: GenerationType,
		params: VideoGenerationParams,
	): void {
		if (kind !== "video") {
			throw new Error("The BytePlus adapter only generates video.");
		}

		const hasImage = Boolean(params.imageUrl ?? params.imageUrls?.length);
		if (!hasImage && !binding.textToVideo) {
			throw new Error(
				`Seedance "${modelId}" only runs image-to-video — pass imageUrl.`,
			);
		}
		if (hasImage && !binding.imageToVideo) {
			throw new Error(`Seedance "${modelId}" only runs text-to-video.`);
		}

		if (params.duration !== undefined) {
			const { min, max } = binding.durations;
			// -1 is legal on 1.5 and 2.x and means "let the model choose".
			const openEnded = params.duration === -1 && binding.family !== "1.0";
			if (!openEnded && (params.duration < min || params.duration > max)) {
				throw new Error(
					`Seedance "${modelId}" accepts durations from ${min} to ${max}s, not ${params.duration}s.`,
				);
			}
		}

		if (params.resolution && !binding.resolutions.includes(params.resolution)) {
			throw new Error(
				`Seedance "${modelId}" supports ${binding.resolutions.join(", ")}, not ${params.resolution}.`,
			);
		}
	}

	private outputsFrom(task: ArkTask): GenerationOutput[] {
		const url = task.content?.video_url;
		if (!url) return [];
		return [
			{
				url,
				mimeType: "video/mp4",
				taskId: task.id,
				// Ark states 24 hours for a result URL.
				expiresAt: expiresInHours(24),
				// Ark bills output tokens only; input is always 0 for video.
				raw: { completionTokens: task.usage?.completion_tokens },
			},
		];
	}

	private snapshot(task: ArkTask, job: Job): JobSnapshot {
		if (task.status === "failed" || task.status === "cancelled") {
			return {
				status: "failed",
				error:
					task.error?.message ?? `Ark reported the task as ${task.status}.`,
			};
		}
		if (task.status === "expired") {
			return {
				status: "failed",
				error: `Ark expired task ${task.id} before it ran.`,
			};
		}
		if (task.status !== "succeeded") return { status: "pending" };

		const outputs = this.outputsFrom(task);
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

	private async run(
		kind: GenerationType,
		params: VideoGenerationParams & ImageGenerationParams,
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

		let taskId: string;
		try {
			const [id, binding] = this.binding(params.model);
			modelId = id;
			this.validate(id, binding, kind, params);

			const task = await this.request<ArkTask>(TASKS_PATH, {
				method: "POST",
				body: this.buildBody(id, binding, params),
			});
			if (!task.id) {
				throw new Error("Ark accepted the request but returned no task id.");
			}
			taskId = task.id;
		} catch (error) {
			return failure(error instanceof Error ? error.message : String(error));
		}

		// submit() wants the handle, not the result.
		if (isSubmitMode()) {
			throw new PendingJob(taskId, TASKS_PATH);
		}

		const job: Job = {
			id: taskId,
			provider: this.providerName,
			model: modelId,
			kind,
			pollEndpoint: TASKS_PATH,
			params,
			submittedAt: new Date(startedAt).toISOString(),
		};

		const maxAttempts = this.opts.maxPollAttempts ?? DEFAULT_MAX_POLL_ATTEMPTS;
		for (let attempt = 0; attempt < maxAttempts; attempt++) {
			const snapshot = await this.completeJob(job);
			if (snapshot.status === "failed") {
				return failure(snapshot.error ?? "Ark task failed.");
			}
			if (snapshot.status === "succeeded" && snapshot.result) {
				return { ...snapshot.result, processingTimeMs: Date.now() - startedAt };
			}
			await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
		}

		return failure(
			`Ark task ${taskId} did not finish after ${maxAttempts} checks.`,
		);
	}

	/** Resume a job submitted earlier, possibly by another process. */
	async completeJob(job: Job): Promise<JobSnapshot> {
		try {
			const task = await this.request<ArkTask>(
				`${job.pollEndpoint ?? TASKS_PATH}/${encodeURIComponent(job.id)}`,
			);
			return this.snapshot(task, job);
		} catch (error) {
			return {
				status: "failed",
				error: error instanceof Error ? error.message : String(error),
			};
		}
	}

	generateVideo(params: VideoGenerationParams): Promise<GenerationResult> {
		return this.run("video", params as never);
	}

	/**
	 * Seedream. Unlike video, `/images/generations` answers synchronously — the
	 * image is in the response and there is no task to poll, so `submit()` returns
	 * an already-settled job for these models.
	 */
	async generateImage(
		params: ImageGenerationParams,
	): Promise<GenerationResult> {
		const startedAt = Date.now();
		const modelId = params.model ?? "";

		const failure = (error: string): GenerationResult => ({
			success: false,
			outputs: [],
			creditsUsed: 0,
			provider: this.providerName,
			model: modelId,
			processingTimeMs: Date.now() - startedAt,
			error,
		});

		const spec = BYTEPLUS_IMAGE_MODELS[modelId];
		if (!spec) {
			return failure(
				`"${modelId}" is not a BytePlus image model. Known: ${Object.keys(BYTEPLUS_IMAGE_MODELS).join(", ")}.`,
			);
		}

		const size = params.resolution ?? "2K";
		if (!spec.sizes.includes(size)) {
			return failure(
				`Seedream "${modelId}" supports ${spec.sizes.join(", ")}, not ${size}.`,
			);
		}

		const body: Record<string, unknown> = {
			model: modelId,
			prompt: params.prompt,
			size,
			response_format: "url",
			// Ark defaults this to true. An SDK that stamps your paid output without
			// being asked is a surprise, so the default is inverted here.
			watermark: false,
		};
		if (params.outputFormat) body.output_format = params.outputFormat;
		if (params.seed !== undefined) body.seed = params.seed;
		const reference = params.referenceImages?.[0];
		if (reference) body.image = reference;

		try {
			const response = await this.request<ArkImageResponse>(IMAGES_PATH, {
				method: "POST",
				body,
			});

			const outputs: GenerationOutput[] = (response.data ?? [])
				.filter((item): item is { url: string } => Boolean(item.url))
				.map((item) => ({
					url: item.url,
					mimeType: params.outputFormat === "png" ? "image/png" : "image/jpeg",
					// The link dies in a day; configure storage to keep it.
					expiresAt: expiresInHours(24),
				}));

			if (outputs.length === 0) {
				return failure("Ark returned no image URL.");
			}

			return {
				success: true,
				outputs,
				creditsUsed: 0,
				provider: this.providerName,
				model: modelId,
				processingTimeMs: Date.now() - startedAt,
			};
		} catch (error) {
			return failure(error instanceof Error ? error.message : String(error));
		}
	}

	/** Cancel a queued task, or delete the record of a finished one. */
	async cancelJob(job: Job): Promise<void> {
		await fetch(`${this.baseUrl}${TASKS_PATH}/${encodeURIComponent(job.id)}`, {
			method: "DELETE",
			headers: { Authorization: `Bearer ${this.opts.apiKey}` },
		});
	}

	generateAudio(_params: AudioGenerationParams): Promise<GenerationResult> {
		throw new Error("BytePlus has no speech synthesis wired up here.");
	}

	generateText(_params: TextGenerationParams): Promise<GenerationResult> {
		throw new Error("The BytePlus adapter does not generate text.");
	}

	async estimateCost(
		type: GenerationType,
		params: GenerationParams,
	): Promise<CostEstimate> {
		return estimateFor(this.providerName, type, params);
	}

	supportsModel(model: string): boolean {
		return model in BYTEPLUS_MODELS || model in BYTEPLUS_IMAGE_MODELS;
	}

	getAvailableModels() {
		return [
			...Object.keys(BYTEPLUS_MODELS).map((id) => ({
				id,
				name: id,
				type: "video" as GenerationType,
			})),
			...Object.keys(BYTEPLUS_IMAGE_MODELS).map((id) => ({
				id,
				name: id,
				type: "image" as GenerationType,
			})),
		];
	}
}
