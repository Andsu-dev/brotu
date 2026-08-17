import type { ProviderConfig } from "@brotu/ai";

export const BROTU_API_KEY_ENV = "BROTU_API_KEY";
export const BROTU_API_URL_ENV = "BROTU_API_URL";
export const BROTU_WORKSPACE_ID_ENV = "BROTU_WORKSPACE_ID";

/** Env vars the CLI reads for each native provider, first match wins. */
export const PROVIDER_ENV: Record<string, readonly string[]> = {
	kling: ["KLING_API_KEY"],
	byteplus: ["ARK_API_KEY", "BYTEPLUS_API_KEY"],
	google: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
	openai: ["OPENAI_API_KEY"],
	qwen: ["QWEN_API_KEY", "DASHSCOPE_API_KEY"],
	elevenlabs: ["ELEVENLABS_API_KEY"],
	topaz: ["TOPAZ_API_KEY", "TOPAZLABS_API_KEY"],
};

const BASE_URL_ENV: Record<string, string> = {
	kling: "KLING_BASE_URL",
	byteplus: "ARK_BASE_URL",
	google: "GEMINI_BASE_URL",
	openai: "OPENAI_BASE_URL",
	qwen: "QWEN_BASE_URL",
	elevenlabs: "ELEVENLABS_BASE_URL",
	topaz: "TOPAZ_BASE_URL",
};

export function providersFromEnv(
	env: NodeJS.ProcessEnv = process.env,
): Record<string, ProviderConfig> {
	const providers: Record<string, ProviderConfig> = {};

	for (const [id, keys] of Object.entries(PROVIDER_ENV)) {
		const apiKey = keys.map((key) => env[key]?.trim()).find(Boolean);
		if (!apiKey) continue;
		const baseUrl = env[BASE_URL_ENV[id] ?? ""]?.trim();
		providers[id] = baseUrl ? { apiKey, baseUrl } : { apiKey };
	}

	return providers;
}

export function brotuApiKey(env: NodeJS.ProcessEnv = process.env): string {
	return env[BROTU_API_KEY_ENV]?.trim() ?? "";
}

export function brotuApiUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
	return env[BROTU_API_URL_ENV]?.trim() || undefined;
}

export function brotuWorkspaceId(
	env: NodeJS.ProcessEnv = process.env,
): string | undefined {
	return env[BROTU_WORKSPACE_ID_ENV]?.trim() || undefined;
}

export function describeExpectedKeys(): string {
	const vendors = Object.entries(PROVIDER_ENV)
		.map(([id, keys]) => `  ${id.padEnd(12)} ${keys.join(" or ")}`)
		.join("\n");
	return `  brotu        ${BROTU_API_KEY_ENV}   from https://brotu.app
${vendors}`;
}
