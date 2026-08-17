import type { AIModelConfig, NodeTypeCapability } from "../constants/model.types";

/**
 * Topaz Labs. Catalog ids are the vendor's own codes on video, and a
 * kebab-case form of the image model name (the API still wants the spaced
 * string in `vendorModel`).
 *
 * Video: POST /video/express. Image: POST /image/v1/<intent>/async.
 */
export type TopazSurface = "video" | "image";
export type TopazFilterKind = "interpolation" | "upscale";

export interface TopazBinding {
	name: string;
	vendorModel: string;
	surface: TopazSurface;
	kind?: TopazFilterKind;
	/** Image intent path under /image/v1. */
	imagePath?: string;
	description: string;
}

const VIDEO_RES = ["720p", "1080p", "4k"] as const;

function video(
	id: string,
	name: string,
	kind: TopazFilterKind,
	description: string,
): [string, TopazBinding] {
	return [id, { name, vendorModel: id, surface: "video", kind, description }];
}

function image(
	id: string,
	name: string,
	vendorModel: string,
	imagePath: string,
	description: string,
): [string, TopazBinding] {
	return [
		id,
		{ name, vendorModel, surface: "image", imagePath, description },
	];
}

const ENTRIES: Array<[string, TopazBinding]> = [
	// Precision video upscale (Proteus family)
	video("prob-4", "Proteus", "upscale", "Default video upscale. Preserves the source."),
	video("pnat-1", "Proteus Natural", "upscale", "Softer Proteus. 2× only."),
	video("rhea-1", "Rhea", "upscale", "High-fidelity 4× upscale for fine detail."),
	video("thd-3", "Theia Fine Tune Detail", "upscale", "More aggressive detail."),
	video("thf-4", "Theia Fine Tune Fidelity", "upscale", "Lighter touch, closer to the source."),
	video("thm-2", "Themis 2", "upscale", "Motion deblur."),
	video("aaa-9", "Artemis Aliasing / Moire", "upscale", "Aliasing and moire cleanup."),
	video("ahq-12", "Artemis High Quality", "upscale", "Artemis for clean footage."),
	video("amq-13", "Artemis Medium Quality", "upscale", "Artemis for typical compression."),
	video("amqs-2", "Artemis Medium Halo", "upscale", "Medium halo reduction."),
	video("alq-13", "Artemis Low Quality", "upscale", "Artemis for degraded sources."),
	video("alqs-2", "Artemis Strong Halo", "upscale", "Strong halo reduction."),
	video("iris-3", "Iris Medium Quality", "upscale", "Face recovery, medium quality."),
	video("iris-2", "Iris Low Quality", "upscale", "Face recovery, low quality."),
	video("dtv-4", "Dione TV", "upscale", "Deinterlace broadcast footage."),
	video("ddv-3", "Dione DV", "upscale", "Deinterlace camcorder footage."),
	video("dtvs-2", "Dione Robust", "upscale", "Deinterlace degraded interlaced sources."),
	video("dtd-4", "Dione Dehalo", "upscale", "Deinterlace with halo cleanup."),
	video("dtds-2", "Dione Robust Dehalo", "upscale", "Deinterlace, degraded, with halo cleanup."),
	video("ghq-5", "Gaia High Quality", "upscale", "CGI and animation, high quality."),
	video("gcg-5", "Gaia CG", "upscale", "General CGI and renders."),
	video("nyx-3", "Nyx", "upscale", "Default video denoise."),
	video("nxl-1", "Nyx XL", "upscale", "Heavy video denoise."),
	video("nxhf-1", "Nyx High Fidelity", "upscale", "Light denoise, keep texture."),
	video("nxf-1", "Nyx Fast", "upscale", "Fast video denoise."),
	video("color-1", "Video Colorization", "upscale", "Black-and-white to color."),

	// Generative / creative video
	video("slp-2.6", "Starlight Precise 2.6", "upscale", "Generative upscale to 4K. Faces, texture, text."),
	video("slhq-1", "Starlight HQ", "upscale", "Maximum quality generative enhance."),
	video("slf-2", "Starlight Fast 2", "upscale", "Faster generative upscale."),
	video("slm-1", "Starlight Mini", "upscale", "Archival and interlaced restoration."),
	video("wonder-1", "Starlight Sharp", "upscale", "Local-first sharpening restore."),
	video("ast-2", "Astra 2", "upscale", "Creative GenAI video upscale."),

	// Frame interpolation — not upscalers
	video("aion-1", "Aion", "interpolation", "Extreme slow motion on complex, high-res motion."),
	video("apo-8", "Apollo", "interpolation", "Default slow-mo and frame-rate conversion."),
	video("apf-2", "Apollo Fast", "interpolation", "Faster Apollo."),
	video("chr-2", "Chronos", "interpolation", "Interpolation for harder motion."),
	video("chf-3", "Chronos Fast", "interpolation", "Faster Chronos."),

	// Image — Gigapixel / enhance
	image("standard-v2", "Standard 2", "Standard V2", "/image/v1/enhance/async", "Default image upscale."),
	image("high-fidelity-v2", "High Fidelity 2", "High Fidelity V2", "/image/v1/enhance/async", "Maximum source preservation."),
	image("low-resolution-v2", "Low Resolution 2", "Low Resolution V2", "/image/v1/enhance/async", "Tiny or heavily compressed sources."),
	image("cgi", "Art & CGI", "CGI", "/image/v1/enhance/async", "Illustrations, renders, game art."),
	image("text-refine", "Text & Shapes", "Text Refine", "/image/v1/enhance/async", "Documents, screenshots, type."),

	// Image — generative enhance
	image("standard-max", "Standard Max", "Standard MAX", "/image/v1/enhance-gen/async", "Default generative image upscale."),
	image("wonder", "Wonder", "Wonder", "/image/v1/enhance-gen/async", "One-click generative restore."),
	image("wonder-3.5", "Wonder 3.5", "Wonder 3.5", "/image/v1/enhance-gen/async", "Highest-quality generative image upscale."),
	image("redefine", "Redefine", "Redefine", "/image/v1/enhance-gen/async", "Prompt-guided generative enhance."),
	image("recovery-v2", "Recover 3", "Recovery V2", "/image/v1/enhance-gen/async", "Heavily damaged sources."),
	image("bloom-2", "Bloom 2", "Bloom 2", "/image/v1/enhance-gen/async", "Creative upscale for GenAI images."),
	image("denoise-max", "Denoise Max", "Denoise Max", "/image/v1/denoise-gen/async", "Highest-quality image denoise."),
];

export const TOPAZ_MODELS: Record<string, TopazBinding> = Object.fromEntries(
	ENTRIES.flatMap(([id, binding]) => {
		const rows: Array<[string, TopazBinding]> = [[id, binding]];
		// Image callers can type the vendor's spaced name too.
		if (binding.surface === "image" && binding.vendorModel !== id) {
			rows.push([binding.vendorModel, binding]);
		}
		return rows;
	}),
);

function nodeTypes(binding: TopazBinding): NodeTypeCapability[] {
	if (binding.surface === "image") return ["image_upscale"];
	return binding.kind === "interpolation" ? ["video_gen"] : ["video_upscale"];
}

export const TOPAZ_CATALOG: AIModelConfig[] = ENTRIES.map(([id, binding]) => ({
	id,
	name: binding.name,
	category: binding.surface,
	inputType:
		binding.surface === "video"
			? ("video_required" as const)
			: ("image_required" as const),
	nodeTypes: nodeTypes(binding),
	creditsPerUnit: 0,
	creditUnit: binding.surface === "video" ? ("second" as const) : ("image" as const),
	supportedResolutions: binding.surface === "video" ? [...VIDEO_RES] : undefined,
	provider: "topaz",
	description: binding.description,
}));

export const TOPAZ_VIDEO_MODELS = Object.fromEntries(
	ENTRIES.filter(([, binding]) => binding.surface === "video"),
) as Record<string, TopazBinding>;

export const TOPAZ_IMAGE_MODELS = Object.fromEntries(
	ENTRIES.filter(([, binding]) => binding.surface === "image"),
) as Record<string, TopazBinding>;
