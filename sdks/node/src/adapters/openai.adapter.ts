import type { Job, JobSnapshot } from "../lib/jobs";
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
import {
	OPENAI_IMAGE_MODELS,
	OPENAI_TEXT_MODELS,
	type OpenAIImageBinding,
} from "../providers/openai.models";
import { estimateFor } from "./estimate";

export interface OpenAIAdapterOptions {
	apiKey: string;
	baseUrl?: string;
	/** Sent as OpenAI-Organization when set. */
	organization?: string;
}

const DEFAULT_BASE_URL = "https://api.openai.com";
const IMAGES_PATH = "/v1/images/generations";

interface OpenAIImageResponse {
	data?: Array<{ b64_json?: string; url?: string; revised_prompt?: string }>;
	error?: { message: string; type?: string; code?: string };
}

/**
 * OpenAI image generation.
 *
 * Two things shape this adapter. It is synchronous — there is no job to poll,
 * so `submit()` hands back an already-settled one. And the gpt-image models
 * return **base64 only**, never a URL, so outputs come back as data URIs. Give
 * the client a `storage` bucket and they are copied into it; `fetch` reads a
 * data URI directly, so nothing special is needed for that.
 */
export class OpenAIAdapter implements ContentGeneratorPort {
	readonly providerName = "openai";
	// No video: the Videos API shuts down on 24 September 2026.
	readonly supportedTypes: GenerationType[] = ["image", "text"];

	private readonly opts: OpenAIAdapterOptions;

	constructor(opts: OpenAIAdapterOptions) {
		this.opts = opts;
	}

	private get baseUrl(): string {
		return (this.opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
	}

	private binding(modelId: string | undefined): [string, OpenAIImageBinding] {
		const id = modelId ?? "";
		const found = OPENAI_IMAGE_MODELS[id];
		if (!found) {
			throw new Error(
				`"${id}" is not an OpenAI image model. Known: ${Object.keys(OPENAI_IMAGE_MODELS).join(", ")}.`,
			);
		}
		return [id, found];
	}

	private buildBody(
		modelId: string,
		binding: OpenAIImageBinding,
		params: ImageGenerationParams,
	): Record<string, unknown> {
		// `quality: auto` is the default and can silently pick high, which is 35x
		// the low tier. Never leave it to the API.
		const quality = params.quality ?? "medium";
		if (!binding.qualities.includes(quality)) {
			throw new Error(
				`OpenAI "${modelId}" offers ${binding.qualities.join(", ")}, not ${quality}.`,
			);
		}

		if (params.resolution && binding.sizes !== "any") {
			if (!binding.sizes.includes(params.resolution)) {
				throw new Error(
					`OpenAI "${modelId}" accepts ${binding.sizes.join(", ")}, not ${params.resolution}.`,
				);
			}
		}
		if (params.resolution && binding.sizes === "any") {
			// Both edges must be multiples of 16, and it errors rather than rounding.
			const [w, h] = params.resolution.split("x").map(Number);
			if (w && h && (w % 16 !== 0 || h % 16 !== 0)) {
				throw new Error(
					`OpenAI "${modelId}" needs both edges divisible by 16; got ${params.resolution}.`,
				);
			}
		}

		const body: Record<string, unknown> = {
			// Omitting it historically defaulted to dall-e-2, which is shut down.
			model: modelId,
			prompt: params.prompt,
			n: 1,
			quality,
		};

		if (params.resolution) body.size = params.resolution;
		if (params.outputFormat) body.output_format = params.outputFormat;

		return { ...body, ...(params.providerOptions?.openai ?? {}) };
	}

	async generateImage(
		params: ImageGenerationParams,
	): Promise<GenerationResult> {
		const startedAt = Date.now();
		let modelId = params.model ?? "";

		const failure = (error: string): GenerationResult => ({
			success: false,
			outputs: [],
			creditsUsed: 0,
			provider: this.providerName,
			model: modelId,
			processingTimeMs: Date.now() - startedAt,
			error,
		});

		try {
			const [id, binding] = this.binding(params.model);
			modelId = id;

			const response = await fetch(`${this.baseUrl}${IMAGES_PATH}`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${this.opts.apiKey}`,
					"Content-Type": "application/json",
					...(this.opts.organization
						? { "OpenAI-Organization": this.opts.organization }
						: {}),
				},
				body: JSON.stringify(this.buildBody(id, binding, params)),
			});

			const payload = (await response.json()) as OpenAIImageResponse;
			if (payload.error) throw new Error(payload.error.message);
			if (!response.ok) {
				throw new Error(`OpenAI returned ${response.status}.`);
			}

			const format = params.outputFormat ?? "png";
			const outputs: GenerationOutput[] = (payload.data ?? [])
				.map((item): GenerationOutput | undefined => {
					// gpt-image models never return a URL, only base64.
					if (item.b64_json) {
						return {
							url: `data:image/${format};base64,${item.b64_json}`,
							mimeType: `image/${format}`,
							raw: { inline: true, revisedPrompt: item.revised_prompt },
						};
					}
					if (item.url) {
						return { url: item.url, mimeType: `image/${format}` };
					}
					return undefined;
				})
				.filter((output): output is GenerationOutput => Boolean(output));

			if (outputs.length === 0) return failure("OpenAI returned no image.");

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

	generateVideo(_params: VideoGenerationParams): Promise<GenerationResult> {
		throw new Error(
			"OpenAI has no supported video API — Sora and the Videos API shut down on 24 September 2026.",
		);
	}

	generateAudio(_params: AudioGenerationParams): Promise<GenerationResult> {
		throw new Error("OpenAI has no speech synthesis wired up here.");
	}

	private textBody(params: TextGenerationParams): Record<string, unknown> {
		const content = params.referenceImages?.length
			? [
					{ type: "input_text", text: params.prompt },
					...params.referenceImages.map((url) => ({
						type: "input_image",
						image_url: url,
					})),
				]
			: params.prompt;

		const input: unknown[] = [];
		if (params.systemPrompt) {
			input.push({ role: "system", content: params.systemPrompt });
		}
		input.push({ role: "user", content });

		return {
			model: params.model,
			input,
			...(params.maxTokens ? { max_output_tokens: params.maxTokens } : {}),
			...(params.temperature !== undefined
				? { temperature: params.temperature }
				: {}),
			...(params.topP !== undefined ? { top_p: params.topP } : {}),
			...(params.providerOptions?.openai ?? {}),
		};
	}

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

		if (!(modelId in OPENAI_TEXT_MODELS)) {
			return failure(
				`"${modelId}" is not an OpenAI text model. Known: ${Object.keys(OPENAI_TEXT_MODELS).join(", ")}.`,
			);
		}

		try {
			const response = await fetch(`${this.baseUrl}/v1/responses`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${this.opts.apiKey}`,
					"Content-Type": "application/json",
					...(this.opts.organization
						? { "OpenAI-Organization": this.opts.organization }
						: {}),
				},
				body: JSON.stringify(this.textBody(params)),
			});

			const payload = (await response.json()) as {
				output_text?: string;
				output?: Array<{
					content?: Array<{ type?: string; text?: string }>;
				}>;
				usage?: { output_tokens?: number };
				error?: { message?: string };
			};
			if (payload.error) throw new Error(payload.error.message);
			if (!response.ok) {
				throw new Error(`OpenAI returned ${response.status}.`);
			}

			const text =
				payload.output_text ??
				payload.output
					?.flatMap((item) => item.content ?? [])
					.find((part) => part.type === "output_text" || part.text)?.text;

			if (!text) return failure("OpenAI returned no text.");

			return {
				success: true,
				outputs: [
					{
						url: `data:text/plain;base64,${Buffer.from(text).toString("base64")}`,
						mimeType: "text/plain",
						raw: { text, tokens: payload.usage?.output_tokens },
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

	/** Synchronous provider: there is never a queued job to come back to. */
	async completeJob(job: Job): Promise<JobSnapshot> {
		return {
			status: "failed",
			error: `OpenAI answers inline, so job ${job.id} has nothing to resume.`,
		};
	}

	async estimateCost(
		type: GenerationType,
		params: GenerationParams,
	): Promise<CostEstimate> {
		const quality =
			(params as ImageGenerationParams).quality === "low"
				? "low"
				: (params as ImageGenerationParams).quality === "high"
					? "high"
					: "medium";
		const binding = OPENAI_IMAGE_MODELS[params.model ?? ""];
		const base = estimateFor(this.providerName, type, params);
		if (!binding) return base;

		return {
			...base,
			usd: binding.usd[quality],
			note: `At ${quality} quality and 1024x1024. Low is ${binding.usd.low}, high is ${binding.usd.high} — the tier moves the price by more than 30x.`,
		};
	}

	supportsModel(model: string): boolean {
		return model in OPENAI_IMAGE_MODELS || model in OPENAI_TEXT_MODELS;
	}

	getAvailableModels() {
		return [
			...Object.keys(OPENAI_IMAGE_MODELS).map((id) => ({
				id,
				name: id,
				type: "image" as GenerationType,
			})),
			...Object.keys(OPENAI_TEXT_MODELS).map((id) => ({
				id,
				name: id,
				type: "text" as GenerationType,
			})),
		];
	}
}
