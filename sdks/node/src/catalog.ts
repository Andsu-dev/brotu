import type { AIModelConfig } from "./constants/model.types";
import {
	BYTEPLUS_CATALOG,
	BYTEPLUS_IMAGE_CATALOG,
} from "./providers/byteplus.models";
import { ELEVENLABS_CATALOG } from "./providers/elevenlabs.models";
import { GOOGLE_CATALOG } from "./providers/google.models";
import { KLING_AUDIO_CATALOG, KLING_CATALOG } from "./providers/kling.models";
import { OPENAI_CATALOG } from "./providers/openai.models";
import { QWEN_CATALOG } from "./providers/qwen.models";
import type { BrotuAIOptions, ResolvedProvider } from "./types";

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
};

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

	const configured = options.providers[id];
	if (!configured) {
		const owned = Object.keys(options.providers).join(", ") || "none";
		throw new Error(
			`Model "${modelId}" runs on "${id}", but no API key was given for it (configured: ${owned}).`,
		);
	}

	const baseUrl = configured.baseUrl ?? PROVIDER_BASE_URLS[id];
	if (!baseUrl) {
		throw new Error(
			`Provider "${id}" has no known base URL — pass providers.${id}.baseUrl.`,
		);
	}

	return { id, apiKey: configured.apiKey, baseUrl: baseUrl.replace(/\/$/, "") };
}

/** Models the caller can actually run, given the keys they supplied. */
export function getAvailableModels(options: BrotuAIOptions): AIModelConfig[] {
	return catalog.filter(
		(model) => model.provider && model.provider in options.providers,
	);
}
