/**
 * Kling capabilities with no portable equivalent.
 *
 * These sit under `ai.kling.*` rather than `ai.video.*` because motion transfer
 * and canvas expansion are not things another vendor implements the same way. A
 * shared signature would be an abstraction nobody could later undo.
 *
 * The namespace only exists when a kling key is configured, so the type tells
 * you the truth about what is reachable.
 */
import { brotuClient } from "../src";

const ai = brotuClient({
	providers: { kling: { apiKey: process.env.KLING_API_KEY ?? "" } },
});

if (!ai.kling) throw new Error("Configure a kling key to use these.");

// -------------------------------------------------- motion transfer

// Your character, someone else's movement.
const { data: motion, error: motionError } = await ai.kling.motionControl({
	model: "kling-2.6",
	imageUrl: "https://example.com/character.png",
	videoUrl: "https://example.com/dance.mp4",
	// `video` allows a 30s reference; `image` caps it at 10s.
	characterOrientation: "video",
	resolution: "1080p",
});

if (!motionError) {
	// The same job handle as everything else.
	const { data } = await ai.jobs.wait(motion);
	console.log(data?.outputs[0]?.url);
}

// -------------------------------------------------- talking head

const { data: talking } = await ai.kling.avatar({
	imageUrl: "https://example.com/portrait.png",
	soundFileUrl: "https://example.com/voice.mp3",
	prompt: "warm, speaking to camera, slight head movement",
	mode: "pro",
});
console.log(talking?.id);

// -------------------------------------------------- the multimodal superset

// Everything is addressed in the prompt by @id.
const { data: omni } = await ai.kling.omniVideo({
	model: "kling-3.0-omni",
	prompt: "@hero walks through the scene from @backdrop, cinematic",
	references: [
		{ type: "refer_image", url: "https://example.com/hero.png", id: "hero" },
		{
			type: "refer_image",
			url: "https://example.com/street.png",
			id: "backdrop",
		},
	],
	resolution: "1080p",
	duration: 10,
	aspectRatio: "9:16",
});
console.log(omni?.id);

// -------------------------------------------------- extend a canvas

// All four ratios are required even at zero, and the result may not exceed
// three times the original area.
const { data: expanded } = await ai.kling.outpainting({
	imageUrl: "https://example.com/square.png",
	up: 0,
	down: 0,
	left: 0.5,
	right: 0.5,
	prompt: "continue the street scene naturally",
});
console.log(expanded?.id);
