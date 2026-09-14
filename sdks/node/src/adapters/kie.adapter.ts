import { getModel } from "../catalog";
import {
	isSubmitMode,
	type Job,
	type JobSnapshot,
	PendingJob,
} from "../lib/jobs";
import { resolveWebhook, type WebhookConfig } from "../lib/webhook";
import type {
	AudioGenerationParams,
	ContentGeneratorPort,
	CostEstimate,
	GenerationOutput,
	GenerationParams,
	GenerationResult,
	GenerationType,
	ImageGenerationParams,
	TextGenerationParams,
	VideoGenerationParams,
} from "../ports/content-generator.port";
import { estimateFor } from "./estimate";

export interface KieAdapterOptions {
	apiKey: string;
	/** Origin plus `/api/v1`, no trailing slash. Defaults to the public API. */
	baseUrl?: string;
	maxPollAttempts?: number;
	/**
	 * URL kie POSTs when a task settles, for every request that names none.
	 * With one set, `submit` never has to be polled — read the callback with
	 * `parseKieCallback` and finish the job from it.
	 */
	callbackUrl?: string;
}

const DEFAULT_BASE_URL = "https://api.kie.ai/api/v1";
const POLL_INTERVAL_MS = 3000;
const DEFAULT_MAX_POLL_ATTEMPTS = 400;

/**
 * Catalog id → kie's market model. Only the ids that differ live here; anything
 * unlisted is sent as-is.
 *
 * A model whose catalog entry carries `endpoint` ("/market/<id>") wins over this
 * table, which is how the platform's own 78-model catalog routes without
 * touching the SDK: register the models and their ids come along.
 *
 * `{mode}` is filled from the request — kie splits text-to-x and image-to-x into
 * two models where the vendors take one.
 */
const KIE_MODEL_IDS: Record<string, string> = {
	"kling/v2-6": "kling-2.6/{mode}-to-video",
	"kling/v3": "kling-3.0/video",
	"dreamina-seedance-2-5-260628": "bytedance/seedance-2-5",
	"dreamina-seedance-2-0-260128": "bytedance/seedance-2",
	"dreamina-seedance-2-0-fast-260128": "bytedance/seedance-2-fast",
	"dreamina-seedance-2-0-mini-260615": "bytedance/seedance-2-mini",
	"wan2.6-t2v": "wan/2-6-text-to-video",
	"wan2.6-i2v": "wan/2-6-image-to-video",
	"wan2.7-t2v": "wan/2-7-text-to-video",
	"wan2.7-i2v": "wan/2-7-image-to-video",
	"gpt-image-1.5": "gpt-image/1.5-{mode}-to-image",
	"gpt-image-2": "gpt-image-2-{mode}-to-image",
	"topaz/video-upscale": "topaz/video-upscale",
};

interface KieEnvelope<T> {
	code?: number;
	msg?: string;
	message?: string;
	data?: T;
}

interface KieTaskRecord {
	taskId?: string;
	model?: string;
	/** waiting | queuing | generating | success | fail */
	state?: string;
	resultJson?: string;
	failCode?: string | number;
	failMsg?: string;
	costTime?: number;
	creditsConsumed?: number;
}

/** What a settled kie task produced, whether it arrived by poll or callback. */
export interface KieTaskResult {
	taskId: string;
	model?: string;
	status: "pending" | "succeeded" | "failed";
	outputs: GenerationOutput[];
	creditsUsed: number;
	error?: string;
}

export class KieAdapter implements ContentGeneratorPort {
	readonly providerName = "kie";
	readonly supportedTypes: GenerationType[] = [
		"image",
		"video",
		"text",
		"audio",
	];

	constructor(private readonly opts: KieAdapterOptions) {}

	private get origin(): string {
		return (this.opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
	}

	private async request<T>(path: string, init?: RequestInit): Promise<T> {
		const response = await fetch(`${this.origin}${path}`, {
			...init,
			headers: {
				Authorization: `Bearer ${this.opts.apiKey}`,
				"Content-Type": "application/json",
				...init?.headers,
			},
		});
		const text = await response.text();
		let body: KieEnvelope<T> | undefined;
		try {
			body = text ? (JSON.parse(text) as KieEnvelope<T>) : undefined;
		} catch {
			body = undefined;
		}

		// kie answers 200 with a code in the body, so both have to be checked.
		const code = body?.code;
		if (!response.ok || (typeof code === "number" && code !== 200)) {
			const message = body?.msg || body?.message || text;
			throw new Error(message || `kie API ${response.status}`);
		}
		if (body?.data === undefined) {
			throw new Error("kie answered without a payload.");
		}
		return body.data;
	}

	/** Which market model serves this request. */
	private marketModel(modelId: string, params: GenerationParams): string {
		const fromCatalog = getModel(modelId)?.endpoint?.replace(
			/^\/market\//,
			"",
		);
		const mapped = fromCatalog || KIE_MODEL_IDS[modelId] || modelId;
		if (!mapped.includes("{mode}")) return mapped;
		return mapped.replace("{mode}", hasInputImage(params) ? "image" : "text");
	}

	private callbackFor(params: GenerationParams): string | undefined {
		const perRequest = resolveWebhook(params.webhook as string | WebhookConfig);
		return perRequest?.url ?? this.opts.callbackUrl;
	}

	private async createTask(
		kind: GenerationType,
		params: GenerationParams,
	): Promise<string> {
		const modelId = params.model ?? "";
		const body: Record<string, unknown> = {
			model: this.marketModel(modelId, params),
			input: buildInput(kind, params, modelId),
		};
		const callBackUrl = this.callbackFor(params);
		if (callBackUrl) body.callBackUrl = callBackUrl;

		const data = await this.request<{ taskId?: string }>("/jobs/createTask", {
			method: "POST",
			body: JSON.stringify(body),
		});
		const taskId = data.taskId?.trim();
		if (!taskId) {
			throw new Error("kie accepted the task but returned no taskId.");
		}
		return taskId;
	}

	/** Ask kie about one task. The same shape a callback carries. */
	async task(taskId: string): Promise<KieTaskResult> {
		const record = await this.request<KieTaskRecord>(
			`/jobs/recordInfo?taskId=${encodeURIComponent(taskId)}`,
		);
		return readTaskRecord(record, taskId);
	}

	private async run(
		kind: GenerationType,
		params: GenerationParams,
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

		let taskId: string;
		try {
			taskId = await this.createTask(kind, params);
		} catch (error) {
			return failure(error instanceof Error ? error.message : String(error));
		}

		const pollEndpoint = `/jobs/recordInfo?taskId=${encodeURIComponent(taskId)}`;
		if (isSubmitMode()) {
			throw new PendingJob(taskId, pollEndpoint);
		}

		const job: Job = {
			id: taskId,
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
				return failure(snapshot.error ?? "kie task failed.");
			}
			if (snapshot.status === "succeeded" && snapshot.result) {
				return { ...snapshot.result, processingTimeMs: Date.now() - startedAt };
			}
			await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
		}

		return failure(
			`kie task ${taskId} did not finish after ${maxAttempts} checks.`,
		);
	}

	async completeJob(job: Job): Promise<JobSnapshot> {
		const settled = await this.task(job.id);
		return snapshotFrom(settled, job.model);
	}

	generateImage(params: ImageGenerationParams): Promise<GenerationResult> {
		return this.run("image", params);
	}

	generateVideo(params: VideoGenerationParams): Promise<GenerationResult> {
		return this.run("video", params);
	}

	generateText(params: TextGenerationParams): Promise<GenerationResult> {
		return this.run("text", params);
	}

	generateAudio(params: AudioGenerationParams): Promise<GenerationResult> {
		return this.run("audio", params);
	}

	async estimateCost(
		type: GenerationType,
		params: GenerationParams,
	): Promise<CostEstimate> {
		return estimateFor(this.providerName, type, params);
	}

	supportsModel(): boolean {
		return true;
	}

	getAvailableModels(): { id: string; name: string; type: GenerationType }[] {
		return [];
	}
}

/**
 * Turn a callback kie POSTed to your endpoint into the same result a poll
 * returns, so the job finishes without asking kie anything.
 *
 * Takes the raw body, parsed or not. It accepts both the enveloped shape
 * (`{ code, data: {…} }`) and a bare record, because a callback and a
 * `recordInfo` answer differ only by that wrapper.
 */
export function parseKieCallback(body: string | unknown): KieTaskResult {
	let parsed: unknown = body;
	if (typeof body === "string") {
		try {
			parsed = JSON.parse(body) as unknown;
		} catch {
			throw new Error("kie callback body is not JSON.");
		}
	}
	const root = asRecord(parsed);
	const record = (asRecord(root?.data) ?? root ?? {}) as KieTaskRecord;
	const taskId = record.taskId?.trim();
	if (!taskId) {
		throw new Error("kie callback carries no taskId.");
	}
	return readTaskRecord(record, taskId);
}

/** The snapshot a job store wants, from a task kie has already answered for. */
export function kieSnapshot(
	settled: KieTaskResult,
	model?: string,
): JobSnapshot {
	return snapshotFrom(settled, model ?? settled.model ?? "");
}

function snapshotFrom(settled: KieTaskResult, model: string): JobSnapshot {
	if (settled.status === "failed") {
		return { status: "failed", error: settled.error ?? "kie task failed." };
	}
	if (settled.status === "pending") return { status: "pending" };
	return {
		status: "succeeded",
		result: {
			success: true,
			outputs: settled.outputs,
			creditsUsed: settled.creditsUsed,
			provider: "kie",
			model,
			processingTimeMs: 0,
		},
	};
}

function readTaskRecord(
	record: KieTaskRecord,
	taskId: string,
): KieTaskResult {
	const state = (record.state ?? "").toLowerCase();
	const creditsUsed = record.creditsConsumed ?? 0;

	if (state === "fail") {
		return {
			taskId,
			model: record.model,
			status: "failed",
			outputs: [],
			creditsUsed,
			error:
				record.failMsg ||
				(record.failCode ? `kie failCode ${record.failCode}` : undefined) ||
				"kie task failed.",
		};
	}
	if (state !== "success") {
		return {
			taskId,
			model: record.model,
			status: "pending",
			outputs: [],
			creditsUsed,
		};
	}

	return {
		taskId,
		model: record.model,
		status: "succeeded",
		outputs: outputsFrom(record.resultJson),
		creditsUsed,
	};
}

/** `resultJson` is a JSON string, and only kie knows why. */
function outputsFrom(resultJson: string | undefined): GenerationOutput[] {
	if (!resultJson) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(resultJson) as unknown;
	} catch {
		return [];
	}
	const record = asRecord(parsed);
	const urls = Array.isArray(record?.resultUrls)
		? record.resultUrls.filter(
				(url): url is string => typeof url === "string" && url.length > 0,
			)
		: [];
	if (urls.length > 0) return urls.map((url) => ({ url, mimeType: mimeFor(url) }));

	// Text models answer with an object instead of a file.
	const object = record?.resultObject;
	if (object !== undefined) {
		const text = typeof object === "string" ? object : JSON.stringify(object);
		return [
			{
				url: `data:text/plain;base64,${Buffer.from(text).toString("base64")}`,
				mimeType: "text/plain",
				raw: { text },
			},
		];
	}
	return [];
}

function mimeFor(url: string): string {
	const path = url.split("?")[0]?.toLowerCase() ?? "";
	if (/\.(mp4|mov|webm|m4v)$/.test(path)) return "video/mp4";
	if (/\.(mp3|wav|m4a|aac)$/.test(path)) return "audio/mpeg";
	if (/\.jpe?g$/.test(path)) return "image/jpeg";
	if (/\.webp$/.test(path)) return "image/webp";
	return "image/png";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object"
		? (value as Record<string, unknown>)
		: undefined;
}

function hasInputImage(params: GenerationParams): boolean {
	const p = params as VideoGenerationParams & ImageGenerationParams;
	return Boolean(
		p.imageUrl || p.imageUrls?.length || p.referenceImages?.length,
	);
}

/**
 * Shared params → kie's `input`.
 *
 * kie names the same field differently per family — kling wants `sound` and a
 * string `duration`, seedance wants `generate_audio` and an integer — so the
 * families with volume get a mapper and everything else gets the common keys.
 * Anything this cannot express goes in `providerOptions.kie`, which is merged
 * last and wins.
 */
function buildInput(
	kind: GenerationType,
	params: GenerationParams,
	modelId: string,
): Record<string, unknown> {
	const raw = params.providerOptions?.kie ?? {};
	const base = modelId.startsWith("kling/")
		? klingInput(params)
		: modelId.includes("seedance")
			? seedanceInput(params)
			: commonInput(kind, params);
	return prune({ ...base, ...raw });
}

function klingInput(params: GenerationParams): Record<string, unknown> {
	const p = params as VideoGenerationParams;
	return {
		prompt: p.prompt,
		negative_prompt: p.negativePrompt,
		aspect_ratio: p.aspectRatio,
		// kie's kling enum is a string, unlike every other family.
		duration: p.duration === undefined ? undefined : String(p.duration),
		sound: p.withAudio,
		image_url: p.imageUrl ?? p.referenceImages?.[0],
	};
}

function seedanceInput(params: GenerationParams): Record<string, unknown> {
	const p = params as VideoGenerationParams;
	return {
		prompt: p.prompt,
		duration: p.duration,
		resolution: p.resolution,
		aspect_ratio: p.aspectRatio,
		first_frame_url: p.imageUrl ?? p.referenceImages?.[0],
		last_frame_url: p.referenceImages?.[1],
		reference_image_urls: p.imageUrls,
		reference_video_urls: p.videoUrls ?? (p.videoUrl ? [p.videoUrl] : undefined),
		generate_audio: p.withAudio,
	};
}

function commonInput(
	kind: GenerationType,
	params: GenerationParams,
): Record<string, unknown> {
	const p = params as VideoGenerationParams & ImageGenerationParams;
	const images = p.imageUrls ?? p.referenceImages;
	return {
		prompt: p.prompt,
		negative_prompt: p.negativePrompt,
		aspect_ratio: p.aspectRatio,
		resolution: p.resolution,
		duration: kind === "video" ? p.duration : undefined,
		seed: p.seed,
		output_format: p.outputFormat,
		image_url: p.imageUrl ?? images?.[0],
		image_urls: images && images.length > 1 ? images : undefined,
		video_url: p.videoUrl,
	};
}

function prune(input: Record<string, unknown>): Record<string, unknown> {
	return Object.fromEntries(
		Object.entries(input).filter(([, value]) => value !== undefined),
	);
}
