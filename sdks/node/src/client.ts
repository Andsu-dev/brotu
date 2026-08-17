import { BrotuAdapter } from "./adapters/brotu.adapter";
import { BytePlusAdapter } from "./adapters/byteplus.adapter";
import { ElevenLabsAdapter } from "./adapters/elevenlabs.adapter";
import { GoogleAdapter } from "./adapters/google.adapter";
import { KlingAdapter } from "./adapters/kling.adapter";
import { OpenAIAdapter } from "./adapters/openai.adapter";
import { QwenAdapter } from "./adapters/qwen.adapter";
import {
	describeModels,
	getAvailableModels,
	getModel,
	type ModelAvailability,
	registerModels,
	resolveProvider,
} from "./catalog";
import type { AIModelCategory, AIModelConfig } from "./constants/model.types";
import {
	type AIError,
	fail,
	failFrom,
	type Generation,
	ok,
	type Result,
} from "./helpers/result";
import {
	isPendingJob,
	type Job,
	type JobSnapshot,
	runInSubmitMode,
} from "./lib/jobs";
import { createS3Storage, persistOutputs, type Storage } from "./lib/storage";
import {
	deliverWebhook,
	resolveWebhook,
	type WebhookConfig,
	type WebhookEvent,
	type WebhookEventName,
} from "./lib/webhook";
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
} from "./ports/content-generator.port";
import {
	type AvatarInput,
	type ImageOmniInput,
	KLING_CAPABILITIES,
	type MotionControlInput,
	type OmniVideoInput,
	type OutpaintingInput,
} from "./providers/kling.models";
import type { BrotuAIOptions } from "./types";

/** Providers this package ships an adapter for. */
export const NATIVE_PROVIDERS = [
	"byteplus",
	"elevenlabs",
	"google",
	"kling",
	"openai",
	"qwen",
] as const;

/** An adapter whose provider queues work and can be asked about it later. */
interface ResumableAdapter {
	completeJob(job: Job): Promise<JobSnapshot>;
}

export interface BrotuAI {
	image: {
		/** Queue the work and return a handle. Only the submit is awaited. */
		submit(params: ImageGenerationParams): Promise<Result<Job>>;
		/** submit + wait. Convenient, but holds the call open for the whole run. */
		generate(params: ImageGenerationParams): Promise<Result<Generation>>;
		/**
		 * Every image model, each labelled with the host that would serve it
		 * (`runsOn`) and whether your keys reach it (`runnable`). Unreachable
		 * models stay in the list, with `reason`, so the gap is visible.
		 */
		list(): ModelAvailability[];
	};
	video: {
		submit(params: VideoGenerationParams): Promise<Result<Job>>;
		generate(params: VideoGenerationParams): Promise<Result<Generation>>;
		list(): ModelAvailability[];
	};
	text: {
		submit(params: TextGenerationParams): Promise<Result<Job>>;
		generate(params: TextGenerationParams): Promise<Result<Generation>>;
		/** Text runs on the vendor, so these need `providers`, not a Brotu key. */
		list(): ModelAvailability[];
	};
	/** Speech synthesis. `prompt` is the text to speak. */
	audio: {
		submit(params: AudioGenerationParams): Promise<Result<Job>>;
		generate(params: AudioGenerationParams): Promise<Result<Generation>>;
		/** Speech runs on the vendor, so these need `providers`, not a Brotu key. */
		list(): ModelAvailability[];
	};
	jobs: {
		/** Ask once. Returns straight away, settled or not. */
		poll(job: Job): Promise<Result<JobSnapshot>>;
		/** Poll until the job settles or `timeoutMs` passes. */
		wait(
			job: Job,
			options?: { timeoutMs?: number },
		): Promise<Result<Generation>>;
	};
	/**
	 * URL the client POSTs when a generation settles. Register at construction
	 * (`webhook:`) or here later. A down hook never fails the generation.
	 */
	webhook: {
		set(value: string | WebhookConfig): void;
		clear(): void;
		get(): WebhookConfig | undefined;
	};
	/**
	 * Google capabilities with no portable equivalent. Present only when a google
	 * key is configured.
	 */
	google?: {
		/**
		 * Generate a video, then keep refining it by talking to the result. Pass
		 * the returned `interactionId` back as `previousInteractionId` and the
		 * model edits what it made instead of starting over — nothing else in the
		 * catalog works this way.
		 */
		omniVideo(
			input: VideoGenerationParams & { previousInteractionId?: string },
		): Promise<Result<{ interactionId?: string; outputs: GenerationOutput[] }>>;
	};
	/**
	 * Kling capabilities with no portable equivalent. They sit under the provider
	 * name because motion transfer and canvas expansion are not things another
	 * vendor implements the same way, and a shared signature would be a lie.
	 * Present only when a kling key is configured.
	 */
	kling?: {
		/** Put your character into another video's movement. */
		motionControl(input: MotionControlInput): Promise<Result<Job>>;
		/** The multimodal superset: frames, references, reference video, elements. */
		omniVideo(input: OmniVideoInput): Promise<Result<Job>>;
		/** A portrait plus an audio track becomes a talking head. */
		avatar(input: AvatarInput): Promise<Result<Job>>;
		/** Extend an image's canvas in any direction. */
		outpainting(input: OutpaintingInput): Promise<Result<Job>>;
		/** Compose or edit across up to ten references. */
		imageOmni(input: ImageOmniInput): Promise<Result<Job>>;
	};
	/** Models this client can run. */
	models(): AIModelConfig[];
	/**
	 * What this generation will be billed for, before running it. Always reports
	 * the billable units; reports USD only where the catalog carries a verified
	 * rate, and `usd: null` otherwise.
	 */
	estimateCost(
		type: GenerationType,
		params: GenerationParams,
	): Promise<Result<CostEstimate>>;
}

export function brotu(options: BrotuAIOptions): BrotuAI {
	const apiKey = options.apiKey?.trim();
	if (!apiKey) {
		throw new Error(
			"Pass a Brotu API key (brotu_sk_…). Get one at https://brotu.app.",
		);
	}

	const optionsWithKey: BrotuAIOptions = { ...options, apiKey };
	const vendors = optionsWithKey.providers ?? {};

	registerModels(options.models);

	let registeredWebhook = resolveWebhook(options.webhook);
	const notifiedJobIds = new Set<string>();

	const storage: Storage | undefined = options.storage
		? createS3Storage(options.storage)
		: undefined;
	// Outputs live on the provider's URL, which expires. Copy them unless told not to.
	const shouldPersist = storage && options.storage?.persistOutputs !== false;

	// One adapter per provider: an adapter talks to a single host, the client routes.
	const adapters = new Map<string, ContentGeneratorPort>();

	/** Route a model to its adapter, reporting the failure rather than throwing. */
	function route(modelId: string | undefined): Result<{
		adapter: ContentGeneratorPort;
		provider: string;
		model: string;
	}> {
		if (!modelId) {
			return fail({
				code: "invalid_request",
				message: "Pass a model id — this SDK ships no implicit default.",
			});
		}

		const model = getModel(modelId);
		if (!model) {
			return fail({
				code: "unknown_model",
				message: `Unknown model "${modelId}".`,
				model: modelId,
			});
		}

		let provider: ReturnType<typeof resolveProvider>;
		try {
			provider = resolveProvider(modelId, optionsWithKey);
		} catch (error) {
			return failFrom("missing_key", error, { model: modelId });
		}

		let adapter = adapters.get(provider.id);
		if (!adapter) {
			const built = buildAdapter(provider);
			if (!built) {
				return fail({
					code: "unsupported_provider",
					message: `No adapter ships for provider "${provider.id}". Native providers: ${NATIVE_PROVIDERS.join(", ")}.`,
					provider: provider.id,
					model: modelId,
				});
			}
			adapter = built;
			adapters.set(provider.id, adapter);
		}

		return ok({ adapter, provider: provider.id, model: modelId });
	}

	function buildAdapter(provider: {
		id: string;
		apiKey: string;
		baseUrl: string;
	}): ContentGeneratorPort | undefined {
		if (provider.id === "brotu") {
			return new BrotuAdapter({
				apiKey,
				apiUrl: optionsWithKey.apiUrl,
				workspaceId: optionsWithKey.workspaceId,
			});
		}
		if (provider.id === "kling") {
			return new KlingAdapter({
				apiKey: provider.apiKey,
				baseUrl: provider.baseUrl,
			});
		}
		if (provider.id === "byteplus") {
			return new BytePlusAdapter({
				apiKey: provider.apiKey,
				baseUrl: provider.baseUrl,
			});
		}
		if (provider.id === "qwen") {
			return new QwenAdapter({
				apiKey: provider.apiKey,
				baseUrl: provider.baseUrl,
			});
		}
		if (provider.id === "openai") {
			return new OpenAIAdapter({
				apiKey: provider.apiKey,
				baseUrl: provider.baseUrl,
			});
		}
		if (provider.id === "elevenlabs") {
			return new ElevenLabsAdapter({
				apiKey: provider.apiKey,
				baseUrl: provider.baseUrl,
				defaultVoiceId: options.elevenLabsVoiceId,
			});
		}
		if (provider.id === "google") {
			return new GoogleAdapter({
				apiKey: provider.apiKey,
				baseUrl: provider.baseUrl,
			});
		}
		return undefined;
	}

	function generateWith(
		adapter: ContentGeneratorPort,
		kind: GenerationType,
		params: GenerationParams,
	): Promise<GenerationResult> {
		if (kind === "image")
			return adapter.generateImage(params as ImageGenerationParams);
		if (kind === "video")
			return adapter.generateVideo(params as VideoGenerationParams);
		if (kind === "audio")
			return adapter.generateAudio(params as AudioGenerationParams);
		return adapter.generateText(params as TextGenerationParams);
	}

	function webhookFor(params?: GenerationParams): WebhookConfig | undefined {
		return resolveWebhook(params?.webhook) ?? registeredWebhook;
	}

	async function notifySettled(input: {
		event: WebhookEventName;
		params?: GenerationParams;
		job?: Job;
		kind?: GenerationType;
		provider?: string;
		model?: string;
		outputs?: Generation["outputs"];
		error?: AIError;
		metadata?: Record<string, string>;
		processingTimeMs?: number;
	}): Promise<void> {
		const config = webhookFor(input.params);
		if (!config) return;

		const jobId = input.job?.id;
		if (jobId) {
			if (notifiedJobIds.has(jobId)) return;
			notifiedJobIds.add(jobId);
		}

		const payload: WebhookEvent = {
			event: input.event,
			jobId,
			provider: input.provider ?? input.job?.provider,
			model: input.model ?? input.job?.model,
			kind: input.kind ?? input.job?.kind,
			outputs: input.outputs,
			error: input.error
				? { code: input.error.code, message: input.error.message }
				: undefined,
			metadata: input.metadata ?? input.job?.metadata,
			processingTimeMs: input.processingTimeMs,
			completedAt: new Date().toISOString(),
		};

		await deliverWebhook(config, payload);
	}

	/** Adapters still speak GenerationResult internally; the seam is here. */
	async function toGeneration(
		raw: GenerationResult,
		metadata?: Record<string, string>,
	): Promise<Result<Generation>> {
		if (!raw.success) {
			return fail({
				code: "provider_error",
				message: raw.error ?? "The provider failed without saying why.",
				provider: raw.provider,
				model: raw.model,
			});
		}

		const outputs =
			shouldPersist && storage
				? await persistOutputs(storage, raw.outputs)
				: raw.outputs;

		return ok({
			outputs,
			provider: raw.provider,
			model: raw.model,
			processingTimeMs: raw.processingTimeMs,
			metadata,
		});
	}

	async function generate(
		kind: GenerationType,
		params: GenerationParams,
	): Promise<Result<Generation>> {
		const routed = route(params.model);
		if (routed.error) return fail(routed.error);

		try {
			const result = await toGeneration(
				await generateWith(routed.data.adapter, kind, params),
				params.metadata,
			);
			if (result.error) {
				await notifySettled({
					event: "generation.failed",
					params,
					kind,
					provider: routed.data.provider,
					model: routed.data.model,
					error: result.error,
					metadata: params.metadata,
				});
				return result;
			}
			await notifySettled({
				event: "generation.succeeded",
				params,
				kind,
				provider: result.data.provider,
				model: result.data.model,
				outputs: result.data.outputs,
				metadata: result.data.metadata,
				processingTimeMs: result.data.processingTimeMs,
			});
			return result;
		} catch (error) {
			const failed = failFrom<Generation>("provider_error", error, {
				provider: routed.data.provider,
				model: routed.data.model,
			});
			if (failed.error) {
				await notifySettled({
					event: "generation.failed",
					params,
					kind,
					provider: routed.data.provider,
					model: routed.data.model,
					error: failed.error,
					metadata: params.metadata,
				});
			}
			return failed;
		}
	}

	async function submit(
		kind: GenerationType,
		params: GenerationParams,
	): Promise<Result<Job>> {
		const routed = route(params.model);
		if (routed.error) return fail(routed.error);

		const base = {
			provider: routed.data.provider,
			model: routed.data.model,
			kind,
			params,
			metadata: params.metadata,
			submittedAt: new Date().toISOString(),
		};

		try {
			// Unwinds with a PendingJob as soon as the provider hands back a task id.
			const raw = await runInSubmitMode(() =>
				generateWith(routed.data.adapter, kind, params),
			);
			// No task id: this provider answered inline, so the job is already done.
			if (!raw.success) {
				const error: AIError = {
					code: "provider_error",
					message: raw.error ?? "The provider rejected the request.",
					provider: raw.provider,
					model: raw.model,
				};
				await notifySettled({
					event: "generation.failed",
					params,
					kind,
					provider: raw.provider,
					model: raw.model,
					error,
					metadata: params.metadata,
				});
				return fail(error);
			}
			const job: Job = {
				...base,
				id: `inline-${base.model}-${base.submittedAt}`,
				result: raw,
			};
			await notifySettled({
				event: "generation.succeeded",
				params,
				job,
				kind,
				provider: raw.provider,
				model: raw.model,
				outputs: raw.outputs,
				metadata: params.metadata,
				processingTimeMs: raw.processingTimeMs,
			});
			return ok(job);
		} catch (error) {
			if (!isPendingJob(error)) {
				return failFrom("provider_error", error, {
					provider: base.provider,
					model: base.model,
				});
			}
			return ok({
				...base,
				id: error.taskId,
				pollEndpoint: error.pollEndpoint,
			});
		}
	}

	async function notifyFromSnapshot(
		job: Job,
		snapshot: JobSnapshot,
	): Promise<void> {
		if (snapshot.status === "succeeded" && snapshot.result) {
			await notifySettled({
				event: "generation.succeeded",
				params: job.params,
				job,
				outputs: snapshot.result.outputs,
				provider: snapshot.result.provider,
				model: snapshot.result.model,
				processingTimeMs: snapshot.result.processingTimeMs,
				metadata: job.metadata,
			});
			return;
		}
		if (snapshot.status === "failed") {
			await notifySettled({
				event: "generation.failed",
				params: job.params,
				job,
				error: {
					code: "provider_error",
					message: snapshot.error ?? "The job failed.",
					provider: job.provider,
					model: job.model,
				},
				metadata: job.metadata,
			});
		}
	}

	async function finalizeSnapshot(
		job: Job,
		snapshot: JobSnapshot,
	): Promise<JobSnapshot> {
		if (snapshot.status === "succeeded" && snapshot.result) {
			const persisted = await toGeneration(snapshot.result, job.metadata);
			if (!persisted.error) {
				snapshot = {
					status: "succeeded",
					result: {
						...snapshot.result,
						outputs: persisted.data.outputs,
					},
				};
			}
		}
		await notifyFromSnapshot(job, snapshot);
		return snapshot;
	}

	async function pollJob(job: Job): Promise<Result<JobSnapshot>> {
		if (job.result) {
			return ok(await finalizeSnapshot(job, job.result.success
				? { status: "succeeded", result: job.result }
				: { status: "failed", error: job.result.error }));
		}

		const routed = route(job.model);
		if (routed.error) return fail(routed.error);

		const adapter = routed.data.adapter as Partial<ResumableAdapter> &
			ContentGeneratorPort;
		if (typeof adapter.completeJob !== "function") {
			return fail({
				code: "unsupported_provider",
				message: `Provider "${job.provider}" cannot resume a job by handle.`,
				provider: job.provider,
			});
		}

		try {
			return ok(await finalizeSnapshot(job, await adapter.completeJob(job)));
		} catch (error) {
			return failFrom("provider_error", error, {
				provider: job.provider,
				model: job.model,
			});
		}
	}

	/** Only built when a kling key is present, so the namespace tells the truth. */
	function klingNamespace(): BrotuAI["kling"] {
		const configured = vendors.kling;
		if (!configured) return undefined;

		const adapter = new KlingAdapter({
			apiKey: configured.apiKey,
			baseUrl: configured.baseUrl ?? "https://api-singapore.klingai.com",
		});

		function run<TInput>(name: keyof typeof KLING_CAPABILITIES) {
			return async (input: TInput): Promise<Result<Job>> => {
				try {
					const capability = KLING_CAPABILITIES[name] as unknown as Parameters<
						typeof adapter.submitCapability<TInput>
					>[1];
					return ok(await adapter.submitCapability(name, capability, input));
				} catch (error) {
					return failFrom("provider_error", error, { provider: "kling" });
				}
			};
		}

		return {
			motionControl: run<MotionControlInput>("motionControl"),
			omniVideo: run<OmniVideoInput>("omniVideo"),
			avatar: run<AvatarInput>("avatar"),
			outpainting: run<OutpaintingInput>("outpainting"),
			imageOmni: run<ImageOmniInput>("imageOmni"),
		};
	}

	/** Only built when a google key is present, so the namespace tells the truth. */
	function googleNamespace(): BrotuAI["google"] {
		const configured = vendors.google;
		if (!configured) return undefined;

		const adapter = new GoogleAdapter({
			apiKey: configured.apiKey,
			baseUrl: configured.baseUrl,
		});

		return {
			omniVideo: async (input) => {
				try {
					return ok(await adapter.omniVideo(input));
				} catch (error) {
					return failFrom("provider_error", error, { provider: "google" });
				}
			},
		};
	}

	/** The catalog for one kind of work, labelled with what actually serves it. */
	function listFor(category: AIModelCategory): ModelAvailability[] {
		return describeModels(optionsWithKey).filter(
			(entry) => entry.model.category === category,
		);
	}

	return {
		google: googleNamespace(),
		kling: klingNamespace(),
		image: {
			submit: (params) => submit("image", params),
			generate: (params) => generate("image", params),
			list: () => listFor("image"),
		},
		video: {
			submit: (params) => submit("video", params),
			generate: (params) => generate("video", params),
			list: () => listFor("video"),
		},
		text: {
			submit: (params) => submit("text", params),
			generate: (params) => generate("text", params),
			list: () => listFor("text"),
		},
		audio: {
			submit: (params) => submit("audio", params),
			generate: (params) => generate("audio", params),
			list: () => listFor("audio"),
		},
		webhook: {
			set(value) {
				registeredWebhook = resolveWebhook(value);
			},
			clear() {
				registeredWebhook = undefined;
			},
			get() {
				return registeredWebhook;
			},
		},
		jobs: {
			poll: pollJob,
			wait: async (job, waitOptions) => {
				const deadline = Date.now() + (waitOptions?.timeoutMs ?? 30 * 60_000);

				for (;;) {
					const polled = await pollJob(job);
					if (polled.error) return fail(polled.error);

					const snapshot = polled.data;
					if (snapshot.status === "succeeded" && snapshot.result) {
						// pollJob already persisted outputs and fired the webhook.
						return ok({
							outputs: snapshot.result.outputs,
							provider: snapshot.result.provider,
							model: snapshot.result.model,
							processingTimeMs: snapshot.result.processingTimeMs,
							metadata: job.metadata,
						});
					}
					if (snapshot.status === "failed") {
						return fail({
							code: "provider_error",
							message: snapshot.error ?? "The job failed.",
							provider: job.provider,
							model: job.model,
						});
					}
					if (Date.now() >= deadline) {
						// Not a dead end: the job may still finish, so say so.
						return fail({
							code: "timeout",
							message: `Job ${job.id} is still running. Poll it again later.`,
							provider: job.provider,
							model: job.model,
						});
					}
					await new Promise((resolve) => setTimeout(resolve, 3000));
				}
			},
		},
		models: () => getAvailableModels(optionsWithKey),
		estimateCost: async (type, params) => {
			const routed = route(params.model);
			if (routed.error) return fail(routed.error);
			try {
				return ok(await routed.data.adapter.estimateCost(type, params));
			} catch (error) {
				return failFrom("provider_error", error, {
					provider: routed.data.provider,
					model: routed.data.model,
				});
			}
		},
	};
}

export type { AIError, Generation, Result };
export { getModel };
