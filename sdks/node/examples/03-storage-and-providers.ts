/**
 * A bucket of your own, and more than one provider.
 *
 * Every provider hands back a presigned URL that expires — 24 hours on BytePlus
 * and Qwen, 30 days on Kling. A job you resume tomorrow would find a dead link,
 * so give the client a bucket and it copies finished outputs into it.
 */
import { brotuClient } from "../src";

const ai = brotuClient({
	providers: {
		kling: { apiKey: process.env.KLING_API_KEY ?? "" },
		byteplus: { apiKey: process.env.ARK_API_KEY ?? "" },
		qwen: { apiKey: process.env.QWEN_API_KEY ?? "" },
	},

	storage: {
		bucket: "my-bucket",
		region: "us-east-2",
		accessKeyId: process.env.S3_KEY ?? "",
		secretAccessKey: process.env.S3_SECRET ?? "",
		// R2, MinIO, or any S3-compatible host.
		endpoint: process.env.S3_ENDPOINT,
		// Set it and nothing gets presigned; leave it out and URLs are signed.
		publicUrl: "https://cdn.example.com",
	},
});

// Models from all three providers, in one list, called the same way.
const byProvider = new Map<string, string[]>();
for (const model of ai.models()) {
	const list = byProvider.get(model.provider ?? "?") ?? [];
	list.push(model.id);
	byProvider.set(model.provider ?? "?", list);
}
console.log(
	[...byProvider].map(([p, ids]) => `${p}: ${ids.length}`).join("  ·  "),
);

// Routing is by model id. Nothing else in the call changes between vendors.
for (const model of ["kling/v2-6", "seedance-1-0-pro-250528", "wan2.7-t2v"]) {
	const { data, error } = await ai.video.submit({
		model,
		prompt: "a cat wearing sunglasses",
		duration: 5,
	});
	console.log(model, error ? `✗ ${error.code}` : `→ ${data.id}`);
}

// After a job settles, outputs[].url points at your bucket and the provider's
// original is kept in metadata.sourceUrl. If one copy fails, that output keeps
// its provider URL rather than failing the whole generation.
