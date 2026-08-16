import { describe, expect, it } from "bun:test";
import { persistOutputs, type Storage } from "../lib/storage";
import type { GenerationOutput } from "../ports/content-generator.port";

const OUTPUTS: GenerationOutput[] = [
	{
		url: "https://provider.example/a.mp4",
		mimeType: "video/mp4",
	},
	{
		url: "https://provider.example/b.mp4",
		mimeType: "video/mp4",
	},
];

function fakeStorage(persist: Storage["persist"]): Storage {
	return {
		persist,
		upload: async () => {
			throw new Error("not used");
		},
	};
}

describe("persistOutputs", () => {
	it("repoints outputs at the bucket and keeps the origin in metadata", async () => {
		const storage = fakeStorage(async (url) =>
			url.replace("https://provider.example", "https://cdn.mine"),
		);

		const result = await persistOutputs(storage, OUTPUTS);

		expect(result.map((o) => o.url)).toEqual([
			"https://cdn.mine/a.mp4",
			"https://cdn.mine/b.mp4",
		]);
		expect(result[0]?.sourceUrl).toBe("https://provider.example/a.mp4");
	});

	it("keeps the provider URL for the one that failed, not for all of them", async () => {
		const storage = fakeStorage(async (url) => {
			if (url.endsWith("a.mp4")) throw new Error("bucket refused it");
			return "https://cdn.mine/b.mp4";
		});

		const result = await persistOutputs(storage, OUTPUTS);

		expect(result[0]?.url).toBe("https://provider.example/a.mp4");
		expect(result[1]?.url).toBe("https://cdn.mine/b.mp4");
	});

	it("does not choke on an empty result", async () => {
		const storage = fakeStorage(async () => "unused");
		expect(await persistOutputs(storage, [])).toEqual([]);
	});
});
