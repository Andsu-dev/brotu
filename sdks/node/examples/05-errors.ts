/**
 * Handling failure, which is a value here rather than an exception.
 *
 * Nothing in the public API throws. `data` is unusable until you narrow on
 * `error`, so a failure is not something the type system lets you forget.
 */
import type { AIError } from "../src";
import { brotu } from "../src";

const ai = brotu({
	apiKey: process.env.BROTU_API_KEY ?? "",
	providers: { kling: { apiKey: process.env.KLING_API_KEY ?? "" } },
});

// ---------------------------------------------------- the six codes

function explain(error: AIError): { retry: boolean; message: string } {
	switch (error.code) {
		case "unknown_model":
			// The id is not in the catalog. Check ai.models().
			return { retry: false, message: `No such model: ${error.model}` };

		case "missing_key":
			// The model's provider has no key on this client.
			return { retry: false, message: `Configure a ${error.provider} key.` };

		case "unsupported_provider":
			// A catalog entry pointing at a provider with no adapter.
			return { retry: false, message: "This SDK cannot run that provider." };

		case "invalid_request":
			// Wrong params for this model — a duration it does not offer, a
			// reference image on a text-only model, and so on.
			return { retry: false, message: error.message };

		case "timeout":
			// Not a dead end: the job is probably still running. Keep the handle
			// and poll again later.
			return { retry: true, message: "Still generating." };

		case "provider_error":
			// The provider rejected it or failed mid-generation. `cause` holds
			// whatever they actually said.
			return { retry: true, message: error.message };
	}
}

// ---------------------------------------------------- in practice

const { data, error } = await ai.video.generate({
	model: "kling/v2-6",
	prompt: "a cat",
	// 7 is not one of the durations this model offers, and the SDK says so
	// before spending anything.
	duration: 7,
});

if (error) {
	const { retry, message } = explain(error);
	console.error(`${error.code}: ${message}${retry ? " (retryable)" : ""}`);
} else {
	console.log(data.outputs[0]?.url);
}

// ---------------------------------------------------- what it catches for you

// Each of these is a real provider constraint the SDK checks locally, so the
// error names the accepted values instead of echoing the provider's terse reply.
const attempts = [
	{ model: "kling/v2-6", prompt: "x", duration: 7 }, // only 5 or 10
	{ model: "kling/v2-5-turbo", prompt: "x", resolution: "4k" }, // 3.0 only
	{ model: "kling/v2-1", prompt: "x" }, // image-to-video only
] as const;

for (const attempt of attempts) {
	const { error } = await ai.video.submit(attempt);
	console.log(attempt.model, "→", error?.message ?? "accepted");
}

// ---------------------------------------------------- tagging a request

// `metadata` is yours: carried through untouched, never sent to the provider,
// and handed back on the job and the result. Use it to correlate a generation
// with whatever it belongs to on your side.
const tagged = await ai.video.submit({
	model: "kling/v2-6",
	prompt: "a cat",
	metadata: { userId: "u_42", campaignId: "c_7", source: "onboarding" },
});

if (tagged.data) {
	// Survives persistence, so a job resumed days later still knows its owner.
	console.log(tagged.data.metadata?.campaignId);

	const { data } = await ai.jobs.wait(tagged.data);
	console.log(data?.metadata?.userId);
}

// ---------------------------------------------------- reaching past the shared params

// Anything one vendor understands and the others do not goes here, merged
// straight into that provider's request body.
await ai.video.submit({
	model: "wan2.7-t2v",
	prompt: "a cat",
	providerOptions: {
		qwen: { prompt_extend: true, shot_type: "multi" },
	},
});
