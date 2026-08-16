import type { Job, JobSnapshot } from "../lib/jobs";
import type {
	AudioGenerationParams,
	ContentGeneratorPort,
	CostEstimate,
	GenerationParams,
	GenerationResult,
	GenerationType,
	ImageGenerationParams,
	TextGenerationParams,
	VideoGenerationParams,
} from "../ports/content-generator.port";
import {
	ELEVENLABS_MODELS,
	ELEVENLABS_OUTPUT_FORMATS,
} from "../providers/elevenlabs.models";
import { estimateFor } from "./estimate";

export interface ElevenLabsAdapterOptions {
	apiKey: string;
	baseUrl?: string;
	/** Used when a request names no voice, since the API has no default. */
	defaultVoiceId?: string;
}

const DEFAULT_BASE_URL = "https://api.elevenlabs.io";

export interface ElevenLabsVoice {
	voiceId: string;
	name: string;
	labels?: Record<string, string>;
}

/**
 * ElevenLabs speech synthesis.
 *
 * Synchronous, and unusual in two ways that this class exists to absorb: the key
 * travels in `xi-api-key` rather than an Authorization header, and the response
 * body is raw audio rather than JSON. The bytes become a data URI so the output
 * looks like every other provider's, and `storage` copies it if configured.
 */
export class ElevenLabsAdapter implements ContentGeneratorPort {
	readonly providerName = "elevenlabs";
	readonly supportedTypes: GenerationType[] = ["audio"];

	private readonly opts: ElevenLabsAdapterOptions;

	constructor(opts: ElevenLabsAdapterOptions) {
		this.opts = opts;
	}

	private get baseUrl(): string {
		return (this.opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
	}

	private get headers(): Record<string, string> {
		// Not an Authorization header — ElevenLabs uses its own.
		return { "xi-api-key": this.opts.apiKey };
	}

	/**
	 * The voices on your account. Voice ids are opaque and account-specific, so
	 * there is no list the catalog could ship.
	 */
	async listVoices(): Promise<ElevenLabsVoice[]> {
		const response = await fetch(`${this.baseUrl}/v1/voices/search`, {
			headers: this.headers,
		});
		if (!response.ok) {
			throw new Error(`ElevenLabs returned ${response.status} listing voices.`);
		}

		const payload = (await response.json()) as {
			voices?: Array<{
				voice_id?: string;
				name?: string;
				labels?: Record<string, string>;
			}>;
		};

		return (payload.voices ?? [])
			.filter((voice) => voice.voice_id)
			.map((voice) => ({
				voiceId: voice.voice_id as string,
				name: voice.name ?? "",
				labels: voice.labels,
			}));
	}

	async generateAudio(
		params: AudioGenerationParams,
	): Promise<GenerationResult> {
		const startedAt = Date.now();
		const modelId = params.model ?? "eleven_multilingual_v2";

		const failure = (error: string): GenerationResult => ({
			success: false,
			outputs: [],
			creditsUsed: 0,
			provider: this.providerName,
			model: modelId,
			processingTimeMs: Date.now() - startedAt,
			error,
		});

		const binding = ELEVENLABS_MODELS[modelId];
		if (!binding) {
			return failure(
				`"${modelId}" is not an ElevenLabs model. Known: ${Object.keys(ELEVENLABS_MODELS).join(", ")}.`,
			);
		}

		// The voice is a path parameter and the API has no fallback for it.
		const voiceId = params.voice ?? this.opts.defaultVoiceId;
		if (!voiceId) {
			return failure(
				"ElevenLabs needs a voice id. Pass `voice`, set `defaultVoiceId` on the provider, or call listVoices() to find one.",
			);
		}

		if (params.prompt.length > binding.maxCharacters) {
			// Caught here because the provider's own limit is per-model and its
			// error does not say what the limit was.
			return failure(
				`ElevenLabs "${modelId}" takes up to ${binding.maxCharacters} characters; got ${params.prompt.length}.`,
			);
		}

		const outputFormat = params.outputFormat
			? // The shared param is a codec; theirs is codec_rate_bitrate.
				`${params.outputFormat}_44100_128`
			: "mp3_44100_128";
		if (!ELEVENLABS_OUTPUT_FORMATS.includes(outputFormat as never)) {
			return failure(
				`ElevenLabs has no output format "${outputFormat}". Pass one through providerOptions.elevenlabs.output_format.`,
			);
		}

		try {
			const response = await fetch(
				`${this.baseUrl}/v1/text-to-speech/${encodeURIComponent(voiceId)}`,
				{
					method: "POST",
					headers: { ...this.headers, "Content-Type": "application/json" },
					body: JSON.stringify({
						text: params.prompt,
						model_id: modelId,
						output_format: outputFormat,
						...(params.language ? { language_code: params.language } : {}),
						...(params.speed !== undefined
							? { voice_settings: { speed: params.speed } }
							: {}),
						...(params.providerOptions?.elevenlabs ?? {}),
					}),
				},
			);

			if (!response.ok) {
				// Errors do come back as JSON, unlike the success path.
				const detail = await response.text();
				throw new Error(`ElevenLabs returned ${response.status}: ${detail}`);
			}

			// The body is the audio itself, not a envelope around it.
			const bytes = Buffer.from(await response.arrayBuffer());
			const mimeType = outputFormat.startsWith("mp3")
				? "audio/mpeg"
				: "audio/wav";

			return {
				success: true,
				outputs: [
					{
						url: `data:${mimeType};base64,${bytes.toString("base64")}`,
						mimeType,
						sizeBytes: bytes.byteLength,
						// Inline bytes: nothing hosted, so nothing expires.
						raw: { inline: true, voiceId, characters: params.prompt.length },
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

	generateImage(_params: ImageGenerationParams): Promise<GenerationResult> {
		throw new Error("ElevenLabs generates speech, not images.");
	}

	generateVideo(_params: VideoGenerationParams): Promise<GenerationResult> {
		throw new Error("ElevenLabs generates speech, not video.");
	}

	generateText(_params: TextGenerationParams): Promise<GenerationResult> {
		throw new Error("ElevenLabs generates speech, not text.");
	}

	/** Synchronous provider: there is never a queued job to come back to. */
	async completeJob(job: Job): Promise<JobSnapshot> {
		return {
			status: "failed",
			error: `ElevenLabs answers inline, so job ${job.id} has nothing to resume.`,
		};
	}

	async estimateCost(
		type: GenerationType,
		params: GenerationParams,
	): Promise<CostEstimate> {
		const base = estimateFor(this.providerName, type, params);
		return {
			...base,
			note: "ElevenLabs bills credits whose dollar value depends on your plan, so no rate is on file. The character count is exact.",
		};
	}

	supportsModel(model: string): boolean {
		return model in ELEVENLABS_MODELS;
	}

	getAvailableModels() {
		return Object.keys(ELEVENLABS_MODELS).map((id) => ({
			id,
			name: id,
			type: "audio" as GenerationType,
		}));
	}
}
