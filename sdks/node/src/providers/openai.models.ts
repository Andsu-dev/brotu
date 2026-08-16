import type { AIModelConfig } from "../constants/model.types";

/**
 * OpenAI images.
 *
 * No video: the Videos API and every Sora model are deprecated with a hard
 * shutdown on 24 September 2026, and OpenAI lists no replacement. Building that
 * adapter would be building something with five weeks left.
 */
export interface OpenAIImageBinding {
	/** Sizes the model accepts. `any` means arbitrary WxH within the limits. */
	sizes: string[] | "any";
	/** Quality tiers, which drive a 35x price swing. */
	qualities: Array<"low" | "medium" | "high">;
	/** gpt-image-2 rejects `background: transparent` outright. */
	transparentBackground: boolean;
	/** Deprecated models still answer, but not for long. */
	shutdownOn?: string;
	/** USD per image, by quality, at 1024x1024. */
	usd: { low: number; medium: number; high: number };
}

const CLASSIC_SIZES = ["1024x1024", "1024x1536", "1536x1024", "auto"];

export const OPENAI_IMAGE_MODELS: Record<string, OpenAIImageBinding> = {
	"gpt-image-2": {
		// Arbitrary WxH: max edge 3840, both edges divisible by 16, ratio up to 3:1.
		sizes: "any",
		qualities: ["low", "medium", "high"],
		// A real capability regression against the older model.
		transparentBackground: false,
		usd: { low: 0.006, medium: 0.053, high: 0.211 },
	},
	"gpt-image-1.5": {
		sizes: CLASSIC_SIZES,
		qualities: ["low", "medium", "high"],
		transparentBackground: true,
		shutdownOn: "2026-12-01",
		usd: { low: 0.009, medium: 0.04, high: 0.2 },
	},
	"gpt-image-1": {
		sizes: CLASSIC_SIZES,
		qualities: ["low", "medium", "high"],
		// The only one left that can do transparency.
		transparentBackground: true,
		usd: { low: 0.011, medium: 0.042, high: 0.167 },
	},
};

export const OPENAI_CATALOG: AIModelConfig[] = Object.entries(
	OPENAI_IMAGE_MODELS,
).map(([id, binding]) => ({
	id,
	name: id,
	category: "image",
	inputType: "image_optional",
	nodeTypes: ["image_gen"],
	creditsPerUnit: 0,
	creditUnit: "image",
	supportedResolutions: binding.sizes === "any" ? undefined : binding.sizes,
	provider: "openai",
	// Medium is the sane middle; `quality: auto` can silently pick high, which
	// is 35x the low tier.
	pricing: { usdPerUnit: binding.usd.medium, unit: "image" },
	description: binding.shutdownOn
		? `Deprecated — OpenAI shuts this down on ${binding.shutdownOn}.`
		: undefined,
}));
