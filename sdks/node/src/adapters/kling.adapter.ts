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
	KLING_AUDIO_MODEL,
	KLING_MODELS,
	KLING_VOICES,
	type KlingCapability,
	type KlingModelBinding,
	type KlingResultField,
} from "../providers/kling.models";
import { estimateFor } from "./estimate";

export interface KlingAdapterOptions {
	apiKey: string;
	baseUrl?: string;
	/** Guards a job that never settles. Defaults to twenty minutes of polling. */
	maxPollAttempts?: number;
}

// api.klingai.com still answers, but Kling's own auth docs mark it the deprecated
// former global host. Beijing is the China endpoint: pass providers.kling.baseUrl.
const DEFAULT_BASE_URL = "https://api-singapore.klingai.com";
const POLL_INTERVAL_MS = 5000;
const DEFAULT_MAX_POLL_ATTEMPTS = 240;

/** Kling wraps everything in this envelope; `code` is 0 on success. */
interface KlingEnvelope<T> {
	code: number;
	message: string;
	request_id: string;
	data?: T;
}

/**
 * The two APIs report differently: the legacy one says `succeed` and nests
 * results under `task_result`, the newer one says `succeeded` with a flat
 * `outputs`. Both shapes are optional so one decoder handles either.
 */
interface KlingTask {
	task_id?: string;
	id?: string;
	task_status?: string;
	status?: string;
	task_status_msg?: string;
	task_result?: {
		videos?: Array<{ url?: string }>;
		images?: Array<{ url?: string }>;
		elements?: Array<{ element_id?: string; url?: string }>;
	};
	outputs?: Array<{ url?: string; watermark_url?: string; duration?: number }>;
}

function stateOf(task: KlingTask): "pending" | "succeeded" | "failed" {
	const raw = (task.status ?? task.task_status ?? "").toLowerCase();
	if (raw === "failed") return "failed";
	// "succeed" is the legacy spelling, "succeeded" the current one.
	if (raw === "succeed" || raw === "succeeded") return "succeeded";
	return "pending";
}

export class KlingAdapter implements ContentGeneratorPort {
	readonly providerName = "kling";
	readonly supportedTypes: GenerationType[] = ["image", "video"];

	private readonly opts: KlingAdapterOptions;

	constructor(opts: KlingAdapterOptions) {
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

		const envelope = (await response.json()) as KlingEnvelope<T>;
		if (envelope.code !== 0) {
			// Kling reports failures with HTTP 200 and a non-zero code, so the status
			// line alone would read every rejection as a success.
			throw new Error(`Kling ${envelope.code}: ${envelope.message}`);
		}
		if (envelope.data === undefined) {
			throw new Error(`Kling returned an empty body for ${path}.`);
		}
		return envelope.data;
	}

	private binding(modelId: string | undefined): [string, KlingModelBinding] {
		const id = modelId ?? "";
		const found = KLING_MODELS[id];
		if (!found) {
			throw new Error(
				`"${id}" is not a Kling model. Known: ${Object.keys(KLING_MODELS).join(", ")}.`,
			);
		}
		return [id, found];
	}

	private submitPath(binding: KlingModelBinding, hasImage: boolean): string {
		if (binding.api === "v1") {
			if (binding.kind === "image") return "/v1/images/generations";
			return hasImage ? "/v1/videos/image2video" : "/v1/videos/text2video";
		}
		return `/${hasImage ? "image-to-video" : "text-to-video"}/${binding.modelName}`;
	}

	private legacyBody(
		binding: KlingModelBinding,
		params: VideoGenerationParams & ImageGenerationParams,
		referenceImage: string | undefined,
	): Record<string, unknown> {
		const body: Record<string, unknown> = {
			model_name: binding.modelName,
			prompt: params.prompt,
		};

		if (params.negativePrompt) body.negative_prompt = params.negativePrompt;
		if (params.aspectRatio && params.aspectRatio !== "auto") {
			body.aspect_ratio = params.aspectRatio;
		}

		if (binding.kind === "video") {
			// The legacy API wants duration as a string.
			body.duration = String(params.duration ?? 5);
			const wanted = params.mode === "pro" ? "pro" : "std";
			body.mode = binding.modes?.includes(wanted)
				? wanted
				: (binding.modes?.[0] ?? wanted);
			if (referenceImage) body.image = referenceImage;
		}

		return body;
	}

	private nextBody(
		params: VideoGenerationParams & ImageGenerationParams,
		referenceImage: string | undefined,
	): Record<string, unknown> {
		const settings: Record<string, unknown> = {};
		if (params.duration) settings.duration = params.duration;
		if (params.resolution) settings.resolution = params.resolution;
		// Only text-to-video takes an aspect ratio; image-to-video derives it from
		// the first frame and rejects the field.
		if (
			!referenceImage &&
			params.aspectRatio &&
			params.aspectRatio !== "auto"
		) {
			settings.aspect_ratio = params.aspectRatio;
		}

		// Image-to-video carries the prompt inside `contents`; text-to-video takes
		// it at the top level. Verified against the live API — the docs show only
		// the contents form, and text-to-video answers "prompt cannot be empty".
		const body: Record<string, unknown> = referenceImage
			? {
					contents: [
						{ type: "prompt", text: params.prompt },
						{ type: "first_frame", url: referenceImage },
					],
				}
			: { prompt: params.prompt };

		if (Object.keys(settings).length > 0) body.settings = settings;
		// The caller's escape hatch wins, since they asked for it by name.
		return { ...body, ...(params.providerOptions?.kling ?? {}) };
	}

	private async submitTask(
		kind: GenerationType,
		params: VideoGenerationParams & ImageGenerationParams,
	): Promise<{ taskId: string; pollEndpoint: string }> {
		const [, binding] = this.binding(params.model);
		const referenceImage = params.imageUrl ?? params.referenceImages?.[0];
		const hasImage = Boolean(referenceImage);

		if (kind === "video" && !hasImage && !binding.textToVideo) {
			throw new Error(
				`Kling model "${params.model}" only runs image-to-video — pass imageUrl.`,
			);
		}
		if (
			binding.resolutions &&
			params.resolution &&
			!binding.resolutions.includes(params.resolution)
		) {
			throw new Error(
				`Kling "${params.model}" supports ${binding.resolutions.join(", ")}, not ${params.resolution}.`,
			);
		}
		if (
			binding.durations &&
			params.duration &&
			!binding.durations.includes(params.duration)
		) {
			// Caught here rather than at the provider, because the message it returns
			// names the bad value without saying what would have been accepted.
			throw new Error(
				`Kling "${params.model}" accepts durations ${binding.durations.join(", ")}s, not ${params.duration}s.`,
			);
		}

		const path = this.submitPath(binding, hasImage);
		const body =
			binding.api === "v1"
				? this.legacyBody(binding, params, referenceImage)
				: this.nextBody(params, referenceImage);

		const task = await this.request<KlingTask>(path, { method: "POST", body });
		const taskId = task.task_id ?? task.id;
		if (!taskId) {
			throw new Error("Kling accepted the request but returned no task id.");
		}

		// The legacy API is polled per-kind; the newer one has one task route.
		return { taskId, pollEndpoint: binding.api === "v1" ? path : "/tasks" };
	}

	private async queryTask(
		pollEndpoint: string,
		taskId: string,
	): Promise<KlingTask> {
		if (pollEndpoint === "/tasks") {
			const tasks = await this.request<KlingTask[]>(
				`/tasks?task_ids=${encodeURIComponent(taskId)}`,
			);
			const task = tasks[0];
			if (!task) throw new Error(`Kling knows no task ${taskId}.`);
			return task;
		}
		return this.request<KlingTask>(
			`${pollEndpoint}/${encodeURIComponent(taskId)}`,
		);
	}

	private outputsFrom(
		task: KlingTask,
		kind: GenerationType,
		resultField?: KlingResultField,
	): GenerationOutput[] {
		const fromNext = task.outputs ?? [];
		// Results do not always land in the same place: avatar uses videos, the
		// image endpoints use images, elements uses elements.
		const legacy = task.task_result;
		const fromLegacy = resultField
			? resultField === "outputs"
				? []
				: ((legacy?.[resultField] as Array<{ url?: string }> | undefined) ?? [])
			: kind === "video"
				? (legacy?.videos ?? [])
				: (legacy?.images ?? []);

		return [...fromNext, ...fromLegacy]
			.filter((item): item is { url: string } => Boolean(item?.url))
			.map((item) => ({
				url: item.url,
				mimeType: kind === "video" ? "video/mp4" : "image/png",
				taskId: task.task_id ?? task.id,
				// Kling clears results after 30 days.
				expiresAt: expiresInHours(24 * 30),
			}));
	}

	/** A capability job carries `kling:<name>:<resultField>` in its model slot. */
	private resultFieldOf(job: Job): KlingResultField | undefined {
		if (!job.model.startsWith("kling:")) return undefined;
		return job.model.split(":")[2] as KlingResultField | undefined;
	}

	private snapshot(task: KlingTask, job: Job): JobSnapshot {
		const state = stateOf(task);
		if (state === "failed") {
			return {
				status: "failed",
				error: task.task_status_msg ?? "Kling task failed.",
			};
		}
		if (state === "pending") return { status: "pending" };

		const outputs = this.outputsFrom(task, job.kind, this.resultFieldOf(job));
		// Succeeded with nothing attached yet: still pending, rather than an empty
		// success the caller would have to special-case.
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

		let submitted: { taskId: string; pollEndpoint: string };
		try {
			modelId = this.binding(params.model)[0];
			submitted = await this.submitTask(kind, params);
		} catch (error) {
			return failure(error instanceof Error ? error.message : String(error));
		}

		// submit() wants the handle, not the result.
		if (isSubmitMode()) {
			throw new PendingJob(submitted.taskId, submitted.pollEndpoint);
		}

		const job: Job = {
			id: submitted.taskId,
			provider: this.providerName,
			model: modelId,
			kind,
			pollEndpoint: submitted.pollEndpoint,
			params,
			submittedAt: new Date(startedAt).toISOString(),
		};

		const maxAttempts = this.opts.maxPollAttempts ?? DEFAULT_MAX_POLL_ATTEMPTS;
		for (let attempt = 0; attempt < maxAttempts; attempt++) {
			const snapshot = await this.completeJob(job);
			if (snapshot.status === "failed") {
				return failure(snapshot.error ?? "Kling task failed.");
			}
			if (snapshot.status === "succeeded" && snapshot.result) {
				return { ...snapshot.result, processingTimeMs: Date.now() - startedAt };
			}
			await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
		}

		return failure(
			`Kling task ${submitted.taskId} did not finish after ${maxAttempts} checks.`,
		);
	}

	/**
	 * Submit any declared capability and hand back a job.
	 *
	 * The three axes that differ between them — API family, body, result field —
	 * all come from the capability itself, so this runs every one of them.
	 */
	async submitCapability<TInput>(
		name: string,
		capability: KlingCapability<TInput>,
		input: TInput,
	): Promise<Job> {
		const path = capability.path(input);
		const task = await this.request<KlingTask>(path, {
			method: "POST",
			body: capability.body(input),
		});

		const taskId = task.task_id ?? task.id;
		if (!taskId) {
			throw new Error(`Kling ${name} returned no task id.`);
		}

		return {
			id: taskId,
			provider: this.providerName,
			// Not a catalog model: the capability plus its result field is what the
			// resume path needs, so it rides in the model slot.
			model: `kling:${name}:${capability.results}`,
			kind: capability.kind === "image" ? "image" : "video",
			// The legacy family polls its own path; the newer one has /tasks.
			pollEndpoint: capability.api === "v1" ? path : "/tasks",
			params: { prompt: "" },
			submittedAt: new Date().toISOString(),
		};
	}

	/** Resume a job submitted earlier, possibly by another process. */
	async completeJob(job: Job): Promise<JobSnapshot> {
		if (!job.pollEndpoint) {
			return { status: "failed", error: "Kling job handle has no endpoint." };
		}

		try {
			return this.snapshot(await this.queryTask(job.pollEndpoint, job.id), job);
		} catch (error) {
			return {
				status: "failed",
				error: error instanceof Error ? error.message : String(error),
			};
		}
	}

	generateImage(params: ImageGenerationParams): Promise<GenerationResult> {
		return this.run("image", params as never);
	}

	generateVideo(params: VideoGenerationParams): Promise<GenerationResult> {
		return this.run("video", params as never);
	}

	/** Your own cloned voices. Presets are in KLING_VOICES. */
	async listVoices(): Promise<Array<{ voiceId: string; name?: string }>> {
		const voices = await this.request<
			Array<{ voice_id?: string; voice_name?: string }>
		>("/v1/general/custom-voices?pageNum=1&pageSize=100");
		return voices
			.filter((voice) => voice.voice_id)
			.map((voice) => ({
				voiceId: voice.voice_id as string,
				name: voice.voice_name,
			}));
	}

	/**
	 * Speech. Synchronous, and snake_case — unlike both video APIs on this host.
	 */
	async generateAudio(
		params: AudioGenerationParams,
	): Promise<GenerationResult> {
		const startedAt = Date.now();
		const modelId = params.model ?? KLING_AUDIO_MODEL;

		const failure = (error: string): GenerationResult => ({
			success: false,
			outputs: [],
			creditsUsed: 0,
			provider: this.providerName,
			model: modelId,
			processingTimeMs: Date.now() - startedAt,
			error,
		});

		const voiceId = params.voice;
		if (!voiceId) {
			return failure(
				`Kling needs a voice id. Presets: ${KLING_VOICES.slice(0, 5).join(", ")}… or one of your own from listVoices().`,
			);
		}

		try {
			const data = await this.request<{
				audio_url?: string;
				url?: string;
				id?: string;
			}>("/v1/audio/tts", {
				method: "POST",
				body: {
					// snake_case: camelCase falls into another DTO and misreports.
					voice_id: voiceId,
					voice_language: params.language ?? "en",
					text: params.prompt,
					...(params.speed !== undefined ? { voice_speed: params.speed } : {}),
					...(params.providerOptions?.kling ?? {}),
				},
			});

			const url = data.audio_url ?? data.url;
			if (!url) return failure("Kling returned no audio URL.");

			return {
				success: true,
				outputs: [
					{
						url,
						mimeType: "audio/mpeg",
						taskId: data.id,
						expiresAt: expiresInHours(24 * 30),
						raw: { voiceId, characters: params.prompt.length },
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

	generateText(_params: TextGenerationParams): Promise<GenerationResult> {
		throw new Error("Kling does not generate text.");
	}

	async estimateCost(
		type: GenerationType,
		params: GenerationParams,
	): Promise<CostEstimate> {
		return estimateFor(this.providerName, type, params);
	}

	supportsModel(model: string): boolean {
		return model in KLING_MODELS;
	}

	getAvailableModels() {
		return Object.entries(KLING_MODELS).map(([id, binding]) => ({
			id,
			name: id,
			type: binding.kind as GenerationType,
		}));
	}
}
