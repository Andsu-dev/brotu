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
	QWEN_AUDIO_MODELS,
	QWEN_IMAGE_MODELS,
	QWEN_IMAGE_PATHS,
	QWEN_TEXT_MODELS,
	QWEN_VIDEO_MODELS,
	type QwenVideoBinding,
	videoPathFor,
} from "../providers/qwen.models";
import { estimateFor } from "./estimate";

export interface QwenAdapterOptions {
	apiKey: string;
	baseUrl?: string;
	maxPollAttempts?: number;
}

// Qwen Cloud is DashScope International underneath. The China host is
// `dashscope.aliyuncs.com`: pass providers.qwen.baseUrl to reach it.
const DEFAULT_BASE_URL = "https://dashscope-intl.aliyuncs.com";
const TASKS_PATH = "/api/v1/tasks";
const POLL_INTERVAL_MS = 5000;
const DEFAULT_MAX_POLL_ATTEMPTS = 240;

/** Everything DashScope returns is wrapped like this. */
interface DashScopeResponse {
	request_id: string;
	code?: string;
	message?: string;
	output?: {
		task_id?: string;
		task_status?:
			| "PENDING"
			| "RUNNING"
			| "SUCCEEDED"
			| "FAILED"
			| "CANCELED"
			// Genuinely spelled both ways across DashScope's own specs.
			| "CANCELLED"
			| "UNKNOWN";
		video_url?: string;
		audio?: { url?: string; id?: string; expires_at?: number; data?: string };
		orig_prompt?: string;
		// A queued task that fails reports its reason here, not at submit time.
		code?: string;
		message?: string;
		results?: Array<{ url?: string }>;
		choices?: Array<{
			message?: { content?: Array<{ image?: string; text?: string }> };
		}>;
	};
	usage?: {
		duration?: number;
		size?: string;
		video_count?: number;
		characters?: number;
	};
}

/**
 * Qwen Cloud / DashScope International.
 *
 * Verified end to end against the live API: this adapter's request shape queued
 * a real task and the poll returned a playable video, which is why the field
 * names here are transcribed rather than inferred.
 */
export class QwenAdapter implements ContentGeneratorPort {
	readonly providerName = "qwen";
	readonly supportedTypes: GenerationType[] = ["image", "video"];

	private readonly opts: QwenAdapterOptions;

	constructor(opts: QwenAdapterOptions) {
		this.opts = opts;
	}

	private get baseUrl(): string {
		return (this.opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
	}

	private async request(
		path: string,
		init?: { method: "POST"; body: unknown; async?: boolean },
	): Promise<DashScopeResponse> {
		const headers: Record<string, string> = {
			Authorization: `Bearer ${this.opts.apiKey}`,
			"Content-Type": "application/json",
		};
		// Without this header DashScope tries to answer synchronously and video
		// generation times out.
		if (init?.async) headers["X-DashScope-Async"] = "enable";

		const response = await fetch(`${this.baseUrl}${path}`, {
			method: init?.method ?? "GET",
			headers,
			body: init ? JSON.stringify(init.body) : undefined,
		});

		const payload = (await response.json()) as DashScopeResponse;
		// A rejection carries a top-level `code`; success has none.
		if (payload.code) {
			throw new Error(`${payload.code}: ${payload.message ?? "unknown"}`);
		}
		return payload;
	}

	private binding(modelId: string | undefined): [string, QwenVideoBinding] {
		const id = modelId ?? "";
		const found = QWEN_VIDEO_MODELS[id];
		if (!found) {
			throw new Error(
				`"${id}" is not a Qwen video model. Known: ${Object.keys(QWEN_VIDEO_MODELS).join(", ")}.`,
			);
		}
		return [id, found];
	}

	private videoBody(
		modelId: string,
		binding: QwenVideoBinding,
		params: VideoGenerationParams & ImageGenerationParams,
	): Record<string, unknown> {
		const input: Record<string, unknown> = { prompt: params.prompt };
		if (params.negativePrompt) input.negative_prompt = params.negativePrompt;

		const first = params.imageUrl ?? params.referenceImages?.[0];
		const last = params.referenceImages?.[1];
		const references = params.imageUrls ?? [];

		// The same endpoint takes four incompatible shapes, chosen by the model.
		switch (binding.shape) {
			case "kf2v": {
				if (!first || !last) {
					throw new Error(
						`Qwen "${modelId}" needs a first and a last frame — pass both in referenceImages.`,
					);
				}
				input.first_frame_url = first;
				input.last_frame_url = last;
				break;
			}
			case "img_url": {
				if (!first) {
					throw new Error(`Qwen "${modelId}" needs an image — pass imageUrl.`);
				}
				input.img_url = first;
				break;
			}
			case "reference_urls": {
				if (references.length === 0) {
					throw new Error(
						`Qwen "${modelId}" needs reference images — pass imageUrls.`,
					);
				}
				input.reference_urls = references;
				break;
			}
			case "media": {
				const media: Array<Record<string, string>> = [];
				if (binding.mode === "video-edit") {
					const video = params.videoUrl ?? params.videoUrls?.[0];
					if (!video) {
						throw new Error(`Qwen "${modelId}" needs a video — pass videoUrl.`);
					}
					media.push({ type: "video", url: video });
				} else if (binding.mode === "r2v") {
					for (const url of references) {
						media.push({ type: "reference_image", url });
					}
				} else if (first) {
					media.push({ type: "first_frame", url: first });
					if (last) media.push({ type: "last_frame", url: last });
				}
				if (media.length > 0) input.media = media;
				break;
			}
		}

		const parameters: Record<string, unknown> = {};

		if (binding.sizing === "size") {
			// wan2.6 and earlier express size as "1280*720", with an asterisk.
			if (params.resolution) parameters.size = params.resolution;
		} else {
			// A defaulted task came back 1920x1080, and billing is per output pixel.
			parameters.resolution = params.resolution ?? "720P";
			if (params.aspectRatio && params.aspectRatio !== "auto") {
				parameters.ratio = params.aspectRatio;
			}
		}

		if (params.duration !== undefined) parameters.duration = params.duration;
		if (params.seed !== undefined) parameters.seed = params.seed;

		// Defaults to true, which silently rewrites the prompt through an LLM,
		// adds seconds of latency and can trip content moderation.
		parameters.prompt_extend = false;

		// Some models stamp a visible mark unless told not to.
		if (binding.watermarkOnByDefault) parameters.watermark = false;

		return {
			model: modelId,
			input,
			// The caller's escape hatch wins, since they asked for it by name.
			parameters: { ...parameters, ...(params.providerOptions?.qwen ?? {}) },
		};
	}

	private outputsFrom(
		payload: DashScopeResponse,
		kind: GenerationType,
	): GenerationOutput[] {
		const output = payload.output;
		if (!output) return [];

		// Three incompatible result shapes across the families.
		const urls = [
			...(output.video_url ? [output.video_url] : []),
			...(output.results ?? [])
				.map((result) => result.url)
				.filter((url): url is string => Boolean(url)),
			...(output.choices ?? []).flatMap((choice) =>
				(choice.message?.content ?? [])
					.map((part) => part.image)
					.filter((image): image is string => Boolean(image)),
			),
		];

		return urls.map((url) => ({
			url,
			mimeType: kind === "video" ? "video/mp4" : "image/png",
			taskId: output.task_id,
			durationSeconds: payload.usage?.duration,
			// The OSS link is presigned and stated as valid for 24 hours.
			expiresAt: expiresInHours(24),
			raw: { size: payload.usage?.size },
		}));
	}

	private snapshot(payload: DashScopeResponse, job: Job): JobSnapshot {
		const status = payload.output?.task_status;

		if (
			status === "FAILED" ||
			status === "CANCELED" ||
			status === "CANCELLED" ||
			// An unknown task id is expired or wrong: terminal, not worth retrying.
			status === "UNKNOWN"
		) {
			const output = payload.output;
			const reason = output?.message ?? `DashScope reported ${status}.`;
			return {
				status: "failed",
				error: output?.code ? `${output.code}: ${reason}` : reason,
			};
		}
		if (status !== "SUCCEEDED") return { status: "pending" };

		const outputs = this.outputsFrom(payload, job.kind);
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

			if (binding.resolutions && params.resolution) {
				if (!binding.resolutions.includes(params.resolution)) {
					throw new Error(
						`Qwen "${id}" supports ${binding.resolutions.join(", ")}, not ${params.resolution}.`,
					);
				}
			}

			const payload = await this.request(videoPathFor(binding), {
				method: "POST",
				body: this.videoBody(id, binding, params),
				async: true,
			});
			const submitted = payload.output?.task_id;
			if (!submitted) {
				throw new Error(
					"DashScope accepted the request but returned no task id.",
				);
			}
			taskId = submitted;
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
				return failure(snapshot.error ?? "DashScope task failed.");
			}
			if (snapshot.status === "succeeded" && snapshot.result) {
				return { ...snapshot.result, processingTimeMs: Date.now() - startedAt };
			}
			await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
		}

		return failure(
			`DashScope task ${taskId} did not finish after ${maxAttempts} checks.`,
		);
	}

	/** Resume a job submitted earlier, possibly by another process. */
	async completeJob(job: Job): Promise<JobSnapshot> {
		try {
			const payload = await this.request(
				`${job.pollEndpoint ?? TASKS_PATH}/${encodeURIComponent(job.id)}`,
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
		return this.run("video", params as never);
	}

	/**
	 * Every image model wired up here answers inline, so this makes no task.
	 *
	 * That is not a style choice: sending `X-DashScope-Async: enable` to a
	 * sync-only model returns 429, which reads as rate limiting and never clears
	 * on retry. The header is gated on the model's own flag for that reason.
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

		const binding = QWEN_IMAGE_MODELS[modelId];
		if (!binding) {
			return failure(
				`"${modelId}" is not a Qwen image model. Known: ${Object.keys(QWEN_IMAGE_MODELS).join(", ")}.`,
			);
		}

		try {
			// Reference images come first and are cited positionally as Image 1, 2, 3.
			// Output aspect ratio follows the last one.
			const content: Array<Record<string, unknown>> = [];
			for (const image of params.referenceImages ?? []) {
				content.push({ image });
			}
			content.push({ text: params.prompt });

			const parameters: Record<string, unknown> = {
				// Several models default to 4, and billing is per image produced.
				n: 1,
				// Defaults to true and silently rewrites the prompt through an LLM.
				prompt_extend: false,
			};
			if (params.resolution) parameters.size = params.resolution;

			const payload = await this.request(QWEN_IMAGE_PATHS[binding.path], {
				method: "POST",
				body:
					binding.body === "messages"
						? {
								model: modelId,
								// The qwen-image family takes chat-style messages.
								input: { messages: [{ role: "user", content }] },
								parameters,
							}
						: {
								model: modelId,
								input: { prompt: params.prompt },
								parameters,
							},
				// Gated deliberately: see the note above.
				async: !binding.sync,
			});

			const outputs = this.outputsFrom(payload, "image");
			if (outputs.length === 0) {
				const reason = payload.output?.message ?? payload.message;
				return failure(reason ?? "DashScope returned no image.");
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

	/**
	 * Speech. Synchronous: the audio URL comes back on the same response, with a
	 * real expiry attached rather than one we guess at.
	 */
	async generateAudio(
		params: AudioGenerationParams,
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

		const binding = QWEN_AUDIO_MODELS[modelId];
		if (!binding) {
			return failure(
				`"${modelId}" is not a Qwen speech model. Known: ${Object.keys(QWEN_AUDIO_MODELS).join(", ")}.`,
			);
		}

		const voice = params.voice ?? binding.voices[0];
		if (!binding.voices.includes(voice)) {
			return failure(
				`Qwen "${modelId}" offers ${binding.voices.join(", ")}, not "${voice}".`,
			);
		}

		try {
			const payload = await this.request(
				"/api/v1/services/aigc/multimodal-generation/generation",
				{
					method: "POST",
					body: {
						model: modelId,
						input: { text: params.prompt },
						parameters: {
							voice,
							...(params.outputFormat ? { format: params.outputFormat } : {}),
							...(params.providerOptions?.qwen ?? {}),
						},
					},
				},
			);

			const audio = payload.output?.audio;
			if (!audio?.url) return failure("Qwen returned no audio.");

			return {
				success: true,
				outputs: [
					{
						url: audio.url,
						mimeType: `audio/${params.outputFormat ?? "mp3"}`,
						taskId: audio.id,
						// A real timestamp from the provider, not an assumed window.
						expiresAt: audio.expires_at
							? new Date(audio.expires_at * 1000).toISOString()
							: undefined,
						raw: { characters: payload.usage?.characters },
					},
				],
				creditsUsed: 0,
				provider: this.providerName,
				model: modelId,
				processingTimeMs: Date.now() - startedAt,
			};
		} catch (error) {
			return failure(error instanceof Error ? error.message : String(error));
		}
	}

	/** Text, through the OpenAI-compatible surface. Synchronous. */
	async generateText(params: TextGenerationParams): Promise<GenerationResult> {
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

		if (!(modelId in QWEN_TEXT_MODELS)) {
			return failure(
				`"${modelId}" is not a Qwen text model. Known: ${Object.keys(QWEN_TEXT_MODELS).join(", ")}.`,
			);
		}

		try {
			const response = await fetch(
				`${this.baseUrl}/compatible-mode/v1/chat/completions`,
				{
					method: "POST",
					headers: {
						Authorization: `Bearer ${this.opts.apiKey}`,
						"Content-Type": "application/json",
					},
					body: JSON.stringify({
						model: modelId,
						messages: [
							...(params.systemPrompt
								? [{ role: "system", content: params.systemPrompt }]
								: []),
							{ role: "user", content: params.prompt },
						],
						...(params.maxTokens ? { max_tokens: params.maxTokens } : {}),
						...(params.temperature !== undefined
							? { temperature: params.temperature }
							: {}),
						...(params.providerOptions?.qwen ?? {}),
					}),
				},
			);

			const payload = (await response.json()) as {
				choices?: Array<{ message?: { content?: string } }>;
				usage?: { completion_tokens?: number; total_tokens?: number };
				error?: { message?: string };
			};
			if (payload.error) throw new Error(payload.error.message ?? "rejected");

			const text = payload.choices?.[0]?.message?.content;
			if (!text) return failure("Qwen returned no text.");

			return {
				success: true,
				// Text has no file, so it rides as a data URI and stays uniform.
				outputs: [
					{
						url: `data:text/plain;base64,${Buffer.from(text).toString("base64")}`,
						mimeType: "text/plain",
						raw: { text, tokens: payload.usage?.completion_tokens },
					},
				],
				creditsUsed: 0,
				provider: this.providerName,
				model: modelId,
				processingTimeMs: Date.now() - startedAt,
			};
		} catch (error) {
			return failure(error instanceof Error ? error.message : String(error));
		}
	}

	async estimateCost(
		type: GenerationType,
		params: GenerationParams,
	): Promise<CostEstimate> {
		return estimateFor(this.providerName, type, params);
	}

	supportsModel(model: string): boolean {
		return (
			model in QWEN_VIDEO_MODELS ||
			model in QWEN_IMAGE_MODELS ||
			model in QWEN_AUDIO_MODELS ||
			model in QWEN_TEXT_MODELS
		);
	}

	getAvailableModels() {
		return [
			...Object.keys(QWEN_VIDEO_MODELS).map((id) => ({
				id,
				name: id,
				type: "video" as GenerationType,
			})),
			...Object.keys(QWEN_IMAGE_MODELS).map((id) => ({
				id,
				name: id,
				type: "image" as GenerationType,
			})),
		];
	}
}
