import type { AIModelCategory, AIModelConfig } from "./constants/model.types";
import {
	BYTEPLUS_CATALOG,
	BYTEPLUS_IMAGE_CATALOG,
} from "./providers/byteplus.models";
import { ELEVENLABS_CATALOG } from "./providers/elevenlabs.models";
import { GOOGLE_CATALOG } from "./providers/google.models";
import { KLING_AUDIO_CATALOG, KLING_CATALOG } from "./providers/kling.models";
import { OPENAI_CATALOG } from "./providers/openai.models";
import { QWEN_CATALOG } from "./providers/qwen.models";
import { TOPAZ_CATALOG } from "./providers/topaz.models";
import type { BrotuAIOptions, ProviderConfig, ResolvedProvider } from "./types";

/**
 * Where each provider lives. A provider absent from here has to be given a
 * `baseUrl`, which is how a self-hosted or regional deployment gets in.
 */
const PROVIDER_BASE_URLS: Record<string, string> = {
	byteplus: "https://ark.ap-southeast.bytepluses.com",
	kling: "https://api-singapore.klingai.com",
	elevenlabs: "https://api.elevenlabs.io",
	google: "https://generativelanguage.googleapis.com",
	openai: "https://api.openai.com",
	qwen: "https://dashscope-intl.aliyuncs.com",
	topaz: "https://api.topazlabs.com",
	brotu: "https://api.brotu.app",
};

export const DEFAULT_BROTU_API_URL = PROVIDER_BASE_URLS.brotu;

function vendorProviders(
	options: BrotuAIOptions,
): Record<string, ProviderConfig> {
	return options.providers ?? {};
}

function brotuApiKey(options: BrotuAIOptions): string | undefined {
	return options.apiKey?.trim() || undefined;
}

/** Every native provider that ships an adapter. */
const BUILT_IN: AIModelConfig[] = [
	...KLING_CATALOG,
	...KLING_AUDIO_CATALOG,
	...BYTEPLUS_CATALOG,
	...BYTEPLUS_IMAGE_CATALOG,
	...QWEN_CATALOG,
	...OPENAI_CATALOG,
	...GOOGLE_CATALOG,
	...ELEVENLABS_CATALOG,
	...TOPAZ_CATALOG,
];

let catalog: AIModelConfig[] = BUILT_IN;
let catalogMap: Record<string, AIModelConfig> = byId(BUILT_IN);

function byId(models: AIModelConfig[]): Record<string, AIModelConfig> {
	return Object.fromEntries(models.map((model) => [model.id, model]));
}

/**
 * Add models, or patch built-in ones, matching on id.
 *
 * Additive and process-wide on purpose: a model definition is static data, like
 * a type, so two clients sharing it is correct. What differs per client is which
 * providers it holds keys for, and that lives in the client's own options.
 */
export function registerModels(models: AIModelConfig[] = []): void {
	if (models.length === 0) return;

	const merged = { ...catalogMap };
	for (const model of models) {
		merged[model.id] = { ...merged[model.id], ...model };
	}

	catalogMap = merged;
	catalog = Object.values(merged);
}

/** Drop every registered model, leaving only the built-ins. For tests. */
export function resetCatalog(): void {
	catalog = BUILT_IN;
	catalogMap = byId(BUILT_IN);
}

export function getModel(modelId: string): AIModelConfig | undefined {
	return catalogMap[modelId];
}

export function getModels(): AIModelConfig[] {
	return catalog;
}

export function hasModel(modelId: string): boolean {
	return modelId in catalogMap;
}

/** Providers with at least one model in the catalog. */
export function getProviders(): string[] {
	return [
		...new Set(
			catalog
				.map((model) => model.provider)
				.filter((provider): provider is string => Boolean(provider)),
		),
	].sort();
}

/**
 * Pick the host and key that serve `modelId`.
 *
 * Every model names its own provider now that nothing is served by an
 * aggregator, so there is no wallet to guess between.
 */
export function resolveProvider(
	modelId: string,
	options: BrotuAIOptions,
): ResolvedProvider {
	const model = getModel(modelId);
	if (!model) {
		throw new Error(`Unknown model "${modelId}".`);
	}

	const id = model.provider;
	if (!id) {
		throw new Error(
			`Model "${modelId}" declares no provider, so nothing knows how to run it.`,
		);
	}

	const configured = vendorProviders(options)[id];
	if (configured) {
		const baseUrl = configured.baseUrl ?? PROVIDER_BASE_URLS[id];
		if (!baseUrl) {
			throw new Error(
				`Provider "${id}" has no known base URL — pass providers.${id}.baseUrl.`,
			);
		}
		return { id, apiKey: configured.apiKey, baseUrl: baseUrl.replace(/\/$/, "") };
	}

	const platformKey = brotuApiKey(options);
	if (platformKey) {
		return {
			id: "brotu",
			apiKey: platformKey,
			baseUrl: (options.apiUrl ?? DEFAULT_BROTU_API_URL).replace(/\/$/, ""),
		};
	}

	const owned = Object.keys(vendorProviders(options)).join(", ") || "none";
	throw new Error(
		`Model "${modelId}" runs on "${id}", but no API key was given for it (configured: ${owned}). Pass a Brotu key to generate on the platform.`,
	);
}

/**
 * What the platform generates on credits. Speech and text are the vendor's
 * work, so a Brotu key alone does not reach them. The Brotu adapter reads this
 * too, so the catalog and the adapter cannot drift apart.
 */
export const BROTU_SUPPORTED_CATEGORIES: AIModelCategory[] = ["image", "video"];

/** A model plus where it would actually run with the keys at hand. */
export interface ModelAvailability {
	model: AIModelConfig;
	/** Provider that serves it: a vendor id, or "brotu" for the platform. */
	runsOn: string;
	/** False when nothing configured can run it. `reason` says why. */
	runnable: boolean;
	reason?: string;
}

/**
 * Every catalog model, each labelled with the host that would serve it. This is
 * the honest view: `runnable: false` entries are the ones a key is missing for,
 * and they stay in the list precisely so the caller can see what is missing.
 */
export function describeModels(options: BrotuAIOptions): ModelAvailability[] {
	const vendors = vendorProviders(options);
	const platformKey = brotuApiKey(options);

	return catalog.map((model) => {
		const provider = model.provider;
		if (!provider) {
			return {
				model,
				runsOn: "(none)",
				runnable: false,
				reason: "The model declares no provider.",
			};
		}
		if (provider in vendors) {
			return { model, runsOn: provider, runnable: true };
		}
		if (platformKey) {
			if (BROTU_SUPPORTED_CATEGORIES.includes(model.category)) {
				return { model, runsOn: "brotu", runnable: true };
			}
			return {
				model,
				runsOn: provider,
				runnable: false,
				reason: `Brotu generates ${BROTU_SUPPORTED_CATEGORIES.join(" and ")} only. Pass providers.${provider} to run this one.`,
			};
		}
		return {
			model,
			runsOn: provider,
			runnable: false,
			reason: `No key for "${provider}". Pass a Brotu key or providers.${provider}.`,
		};
	});
}

/** Models the caller can actually run, given the keys they supplied. */
export function getAvailableModels(options: BrotuAIOptions): AIModelConfig[] {
	return describeModels(options)
		.filter((entry) => entry.runnable)
		.map((entry) => entry.model);
}
