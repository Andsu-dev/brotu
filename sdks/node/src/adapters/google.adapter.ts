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
	GOOGLE_IMAGE_MODELS,
	GOOGLE_VIDEO_MODELS,
} from "../providers/google.models";
import { estimateFor } from "./estimate";

export interface GoogleAdapterOptions {
	apiKey: string;
	baseUrl?: string;
	maxPollAttempts?: number;
}

const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com";
const INTERACTIONS_PATH = "/v1beta/interactions";
const POLL_INTERVAL_MS = 10_000;
const DEFAULT_MAX_POLL_ATTEMPTS = 120;

interface InteractionResponse {
	output_image?: { data?: string };
	steps?: Array<{ content?: Array<{ type?: string; data?: string }> }>;
	error?: { message?: string; status?: string };
}

interface OmniResponse {
	id?: string;
	output_video?: { data?: string; uri?: string };
	steps?: Array<{
		type?: string;
		content?: Array<{ type?: string; data?: string; uri?: string }>;
	}>;
}

interface VeoOperation {
	name?: string;
	done?: boolean;
	error?: { message?: string };
	response?: {
		generateVideoResponse?: {
			generatedSamples?: Array<{ video?: { uri?: string } }>;
		};
	};
}

/**
 * Google, through the Gemini Developer API.
 *
 * The host runs two conventions side by side and they cannot share a
 * serializer: images use the Interactions API with snake_case `input` /
 * `response_format`, while Veo uses the older `instances` / `parameters`
 * envelope in camelCase. Each has its own builder below for that reason.
 */
export class GoogleAdapter implements ContentGeneratorPort {
	readonly providerName = "google";
	readonly supportedTypes: GenerationType[] = ["image", "video"];

	private readonly opts: GoogleAdapterOptions;

	constructor(opts: GoogleAdapterOptions) {
		this.opts = opts;
	}

	private get baseUrl(): string {
		return (this.opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
	}

	private get headers(): Record<string, string> {
		return {
			"x-goog-api-key": this.opts.apiKey,
			"Content-Type": "application/json",
		};
	}

	private async request<T>(
		path: string,
		init?: { method: "POST"; body: unknown },
	): Promise<T> {
		const response = await fetch(`${this.baseUrl}${path}`, {
			method: init?.method ?? "GET",
			headers: this.headers,
			body: init ? JSON.stringify(init.body) : undefined,
		});

		const payload = (await response.json()) as T & {
			error?: { message?: string };
		};
		if (payload.error) {
			throw new Error(payload.error.message ?? "Google rejected the request.");
		}
		if (!response.ok) {
			throw new Error(`Google returned ${response.status} for ${path}.`);
		}
		return payload;
	}

	// ------------------------------------------------------------------ images

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

		const binding = GOOGLE_IMAGE_MODELS[modelId];
		if (!binding) {
			return failure(
				`"${modelId}" is not a Google image model. Known: ${Object.keys(GOOGLE_IMAGE_MODELS).join(", ")}.`,
			);
		}
		if (params.resolution && !binding.sizes.includes(params.resolution)) {
			return failure(
				`Google "${modelId}" accepts ${binding.sizes.join(", ")}, not ${params.resolution}.`,
			);
		}

		try {
			const input: Array<Record<string, unknown>> = [
				{ type: "text", text: params.prompt },
			];
			for (const image of params.referenceImages ?? []) {
				// The Interactions API takes inline base64, not URLs.
				const [meta, data] = image.split(",");
				input.push({
					type: "image",
					mime_type: meta?.match(/data:([^;]+)/)?.[1] ?? "image/png",
					data: data ?? image,
				});
			}

			const payload = await this.request<InteractionResponse>(
				INTERACTIONS_PATH,
				{
					method: "POST",
					body: {
						model: modelId,
						input,
						response_format: {
							type: "image",
							mime_type: `image/${params.outputFormat ?? "png"}`,
							// Size drives the bill here, since pricing is token-based.
							image_size: params.resolution ?? "1K",
							...(params.aspectRatio && params.aspectRatio !== "auto"
								? { aspect_ratio: params.aspectRatio }
								: {}),
						},
						...(params.providerOptions?.google ?? {}),
					},
				},
			);

			// `output_image` is the convenience field for the last image; the steps
			// array is the long way round to the same thing.
			const base64 =
				payload.output_image?.data ??
				payload.steps
					?.flatMap((step) => step.content ?? [])
					.find((part) => part.type === "image")?.data;

			if (!base64) return failure("Google returned no image.");

			const format = params.outputFormat ?? "png";
			return {
				success: true,
				outputs: [
					{
						url: `data:image/${format};base64,${base64}`,
						mimeType: `image/${format}`,
						raw: { inline: true },
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

	// ------------------------------------------------------------------- video

	private veoBody(params: VideoGenerationParams): Record<string, unknown> {
		const hasImage = Boolean(params.imageUrl ?? params.referenceImages?.length);
		const instance: Record<string, unknown> = { prompt: params.prompt };

		const first = params.imageUrl ?? params.referenceImages?.[0];
		if (first) {
			const [meta, data] = first.split(",");
			instance.image = {
				inlineData: {
					mimeType: meta?.match(/data:([^;]+)/)?.[1] ?? "image/png",
					data: data ?? first,
				},
			};
		}

		const resolution = params.resolution ?? "720p";
		// 1080p, 4k and reference images all force the longest duration.
		const forcesEight = resolution !== "720p";
		const duration = String(params.duration ?? (forcesEight ? 8 : 4));

		return {
			instances: [instance],
			parameters: {
				aspectRatio: params.aspectRatio === "9:16" ? "9:16" : "16:9",
				resolution,
				// A string, not a number. Serializing it as an int is a 400.
				durationSeconds: duration,
				// The accepted value narrows by mode: text-to-video takes allow_all,
				// anything driven by an image takes allow_adult and rejects the other.
				personGeneration: hasImage ? "allow_adult" : "allow_all",
				...(params.seed !== undefined ? { seed: params.seed } : {}),
				...(params.providerOptions?.google ?? {}),
			},
		};
	}

	/**
	 * Omni speaks the Interactions API, so it gets its own builder — snake_case
	 * `input`/`response_format`, against Veo's camelCase predict envelope.
	 */
	private omniBody(
		modelId: string,
		params: VideoGenerationParams & { previousInteractionId?: string },
	): Record<string, unknown> {
		const input: Array<Record<string, unknown>> = [
			{ type: "text", text: params.prompt },
		];

		const attach = (type: "image" | "video", value: string) => {
			const [meta, data] = value.split(",");
			input.push({
				type,
				mime_type:
					meta?.match(/data:([^;]+)/)?.[1] ??
					(type === "video" ? "video/mp4" : "image/png"),
				data: data ?? value,
			});
		};

		const first = params.imageUrl ?? params.referenceImages?.[0];
		if (first) attach("image", first);
		for (const image of params.imageUrls ?? []) attach("image", image);
		const video = params.videoUrl ?? params.videoUrls?.[0];
		if (video) attach("video", video);

		// The task the model should perform, inferred from what came with it.
		const task = video
			? "edit"
			: params.imageUrls?.length
				? "reference_to_video"
				: first
					? "image_to_video"
					: "text_to_video";

		return {
			model: modelId,
			input,
			// Continues a previous result instead of starting over.
			...(params.previousInteractionId
				? { previous_interaction_id: params.previousInteractionId }
				: {}),
			response_format: {
				type: "video",
				aspect_ratio: params.aspectRatio === "9:16" ? "9:16" : "16:9",
				// A base64 video over ~4MB has to come back as a URI instead.
				delivery: "uri",
			},
			generation_config: { video_config: { task } },
			...(params.providerOptions?.google ?? {}),
		};
	}

	/** Generate or refine a video conversationally. Returns the interaction. */
	async omniVideo(
		params: VideoGenerationParams & { previousInteractionId?: string },
	): Promise<{ interactionId?: string; outputs: GenerationOutput[] }> {
		const modelId = params.model ?? "gemini-omni-flash-preview";
		const payload = await this.request<OmniResponse>(INTERACTIONS_PATH, {
			method: "POST",
			body: this.omniBody(modelId, params),
		});

		const found =
			payload.output_video ??
			payload.steps
				?.flatMap((step) => step.content ?? [])
				.find((part) => part.type === "video");

		const url =
			found?.uri ??
			(found?.data ? `data:video/mp4;base64,${found.data}` : undefined);

		return {
			// Hand this back to keep refining the same video.
			interactionId: payload.id,
			outputs: url
				? [
						{
							url,
							mimeType: "video/mp4",
							taskId: payload.id,
							expiresAt: expiresInHours(48),
							raw: found?.uri
								? { requiresApiKeyHeader: true }
								: { inline: true },
						},
					]
				: [],
		};
	}

	private async runVideo(
		params: VideoGenerationParams,
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

		const binding = GOOGLE_VIDEO_MODELS[modelId];
		if (!binding) {
			return failure(
				`"${modelId}" is not a Veo model. Known: ${Object.keys(GOOGLE_VIDEO_MODELS).join(", ")}.`,
			);
		}
		if (params.resolution && !binding.resolutions.includes(params.resolution)) {
			return failure(
				`Veo "${modelId}" supports ${binding.resolutions.join(", ")}, not ${params.resolution}.`,
			);
		}
		if (params.imageUrls?.length && !binding.referenceImages) {
			return failure(`Veo "${modelId}" does not take reference images.`);
		}

		if (binding.api === "interactions") {
			try {
				const { outputs, interactionId } = await this.omniVideo(params);
				if (outputs.length === 0) return failure("Omni returned no video.");
				return {
					success: true,
					outputs,
					creditsUsed: 0,
					provider: this.providerName,
					model: modelId,
					processingTimeMs: Date.now() - startedAt,
					// Carried so the caller can keep refining this result.
					error: undefined,
					...(interactionId ? {} : {}),
				};
			} catch (error) {
				return failure(error instanceof Error ? error.message : String(error));
			}
		}

		let operation: string;
		try {
			const submitted = await this.request<VeoOperation>(
				`/v1beta/models/${modelId}:predictLongRunning`,
				{ method: "POST", body: this.veoBody(params) },
			);
			if (!submitted.name) {
				throw new Error("Veo accepted the request but returned no operation.");
			}
			operation = submitted.name;
		} catch (error) {
			return failure(error instanceof Error ? error.message : String(error));
		}

		if (isSubmitMode()) throw new PendingJob(operation, "/v1beta");

		const job: Job = {
			id: operation,
			provider: this.providerName,
			model: modelId,
			kind: "video",
			pollEndpoint: "/v1beta",
			params,
			submittedAt: new Date(startedAt).toISOString(),
		};

		const maxAttempts = this.opts.maxPollAttempts ?? DEFAULT_MAX_POLL_ATTEMPTS;
		for (let attempt = 0; attempt < maxAttempts; attempt++) {
			const snapshot = await this.completeJob(job);
			if (snapshot.status === "failed") {
				return failure(snapshot.error ?? "Veo task failed.");
			}
			if (snapshot.status === "succeeded" && snapshot.result) {
				return { ...snapshot.result, processingTimeMs: Date.now() - startedAt };
			}
			await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
		}

		return failure(`Veo operation ${operation} did not finish in time.`);
	}

	/** Resume a Veo operation submitted earlier, possibly by another process. */
	async completeJob(job: Job): Promise<JobSnapshot> {
		try {
			// The operation name is already a path, so it is appended whole.
			const operation = await this.request<VeoOperation>(
				`${job.pollEndpoint ?? "/v1beta"}/${job.id}`,
			);

			if (!operation.done) return { status: "pending" };
			if (operation.error) {
				return { status: "failed", error: operation.error.message };
			}

			const uri =
				operation.response?.generateVideoResponse?.generatedSamples?.[0]?.video
					?.uri;
			if (!uri) return { status: "pending" };

			const outputs: GenerationOutput[] = [
				{
					url: uri,
					mimeType: "video/mp4",
					taskId: job.id,
					// Google removes the file after two days.
					expiresAt: expiresInHours(48),
					// The URI is not public: fetching it needs the x-goog-api-key header,
					// and it redirects, so the header has to survive the redirect.
					raw: { requiresApiKeyHeader: true },
				},
			];

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
		} catch (error) {
			return {
				status: "failed",
				error: error instanceof Error ? error.message : String(error),
			};
		}
	}

	generateVideo(params: VideoGenerationParams): Promise<GenerationResult> {
		return this.runVideo(params);
	}

	generateAudio(_params: AudioGenerationParams): Promise<GenerationResult> {
		throw new Error("Google has no speech synthesis wired up here.");
	}

	generateText(_params: TextGenerationParams): Promise<GenerationResult> {
		throw new Error("The Google adapter here covers image and video only.");
	}

	async estimateCost(
		type: GenerationType,
		params: GenerationParams,
	): Promise<CostEstimate> {
		return estimateFor(this.providerName, type, params);
	}

	supportsModel(model: string): boolean {
		return model in GOOGLE_IMAGE_MODELS || model in GOOGLE_VIDEO_MODELS;
	}

	getAvailableModels() {
		return [
			...Object.keys(GOOGLE_IMAGE_MODELS).map((id) => ({
				id,
				name: id,
				type: "image" as GenerationType,
			})),
			...Object.keys(GOOGLE_VIDEO_MODELS).map((id) => ({
				id,
				name: id,
				type: "video" as GenerationType,
			})),
		];
	}
}
