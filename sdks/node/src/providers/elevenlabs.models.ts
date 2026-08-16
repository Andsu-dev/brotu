import type { AIModelConfig } from "../constants/model.types";

/**
 * ElevenLabs speech.
 *
 * It breaks two conventions every other provider here follows, and the adapter
 * exists mostly to absorb them: the key goes in `xi-api-key` rather than an
 * Authorization header, and the response is raw audio bytes rather than JSON.
 *
 * The voice is a path parameter and is required — there is no default. Voice
 * ids are opaque strings from your own account, so the catalog cannot ship a
 * list; `listVoices()` on the adapter fetches yours.
 */
export interface ElevenLabsModelBinding {
	/** Maximum characters the model accepts in one request. */
	maxCharacters: number;
	languages: number;
	/** Roughly what it is for, since the ids do not say. */
	note: string;
}

export const ELEVENLABS_MODELS: Record<string, ElevenLabsModelBinding> = {
	eleven_v3: {
		maxCharacters: 5_000,
		languages: 70,
		note: "Most expressive; widest language coverage.",
	},
	eleven_multilingual_v2: {
		maxCharacters: 10_000,
		languages: 29,
		note: "Lifelike and consistent across languages. The API default.",
	},
	eleven_flash_v2_5: {
		maxCharacters: 40_000,
		languages: 32,
		note: "~75ms latency, for real-time and agent use.",
	},
};

/**
 * `codec_samplerate_bitrate`. The API defaults to mp3_44100_128, and the higher
 * tiers are gated behind paid plans.
 */
export const ELEVENLABS_OUTPUT_FORMATS = [
	"mp3_22050_32",
	"mp3_44100_32",
	"mp3_44100_64",
	"mp3_44100_96",
	"mp3_44100_128",
	"mp3_44100_192",
	"pcm_16000",
	"pcm_22050",
	"pcm_24000",
	"pcm_44100",
	"ulaw_8000",
] as const;

export const ELEVENLABS_CATALOG: AIModelConfig[] = Object.entries(
	ELEVENLABS_MODELS,
).map(([id, binding]) => ({
	id,
	name: id,
	category: "audio",
	inputType: "text_only",
	nodeTypes: ["text"],
	creditsPerUnit: 0,
	creditUnit: "character",
	provider: "elevenlabs",
	// Billed in credits whose dollar value depends on your plan, so no verified
	// per-character rate goes in the catalog.
	description: `${binding.note} Up to ${binding.maxCharacters.toLocaleString()} characters, ${binding.languages} languages.`,
}));
