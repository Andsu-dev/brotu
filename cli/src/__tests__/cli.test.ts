import { describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrotuAI, Generation, Job } from "@brotu/ai";
import { parseArgs } from "../args";
import { providersFromEnv } from "../env";
import { type CliIo, run } from "../run";
import { saveOutput } from "../save";

function io() {
	const stdout: string[] = [];
	const stderr: string[] = [];
	const sink: CliIo = {
		stdout: (line) => stdout.push(line),
		stderr: (line) => stderr.push(line),
	};
	return { sink, stdout, stderr };
}

const SETTLED: Generation = {
	outputs: [
		{ url: "https://cdn.example/out.mp4", mimeType: "video/mp4", sizeBytes: 1 },
	],
	provider: "kling",
	model: "kling/v2-6",
	processingTimeMs: 12,
};

const JOB: Job = {
	id: "task-1",
	provider: "kling",
	model: "kling/v2-6",
	kind: "video",
	params: { prompt: "a cat" },
	submittedAt: new Date(0).toISOString(),
};

function fakeClient(overrides: Partial<BrotuAI> = {}): BrotuAI {
	return {
		image: {
			submit: async () => ({ data: JOB, error: null }),
			generate: async () => ({ data: SETTLED, error: null }),
		},
		video: {
			submit: async () => ({ data: JOB, error: null }),
			generate: async () => ({ data: SETTLED, error: null }),
		},
		text: {
			submit: async () => ({ data: JOB, error: null }),
			generate: async () => ({
				data: {
					...SETTLED,
					outputs: [
						{
							url: "data:text/plain,hi",
							mimeType: "text/plain",
							raw: { text: "hello" },
						},
					],
				},
				error: null,
			}),
		},
		audio: {
			submit: async () => ({ data: JOB, error: null }),
			generate: async () => ({ data: SETTLED, error: null }),
		},
		jobs: {
			poll: async () => ({
				data: { status: "succeeded" as const, result: undefined },
				error: null,
			}),
			wait: async () => ({ data: SETTLED, error: null }),
		},
		webhook: {
			set() {},
			clear() {},
			get() {
				return undefined;
			},
		},
		models: () => [
			{
				id: "kling/v2-6",
				name: "Kling 2.6",
				category: "video",
				provider: "kling",
				inputType: "text_only",
				nodeTypes: ["video_gen"],
				creditsPerUnit: 1,
				creditUnit: "second",
			},
		],
		estimateCost: async () => ({
			data: {
				unit: "second",
				units: 5,
				usd: 0.2,
				provider: "kling",
				model: "kling/v2-6",
			},
			error: null,
		}),
		...overrides,
	};
}

describe("parseArgs", () => {
	it("reads a video command with short flags", () => {
		const parsed = parseArgs([
			"video",
			"a cat",
			"-m",
			"kling/v2-6",
			"--wait",
			"--duration",
			"5",
		]);
		expect(parsed.command).toBe("video");
		expect(parsed.positionals).toEqual(["a cat"]);
		expect(parsed.flags.model).toBe("kling/v2-6");
		expect(parsed.flags.wait).toBe(true);
		expect(parsed.flags.duration).toBe("5");
	});

	it("treats job wait as a subcommand", () => {
		const parsed = parseArgs(["job", "wait", "job.json", "--timeout", "1000"]);
		expect(parsed.command).toBe("job");
		expect(parsed.subcommand).toBe("wait");
		expect(parsed.positionals).toEqual(["job.json"]);
		expect(parsed.flags.timeout).toBe("1000");
	});
});

describe("providersFromEnv", () => {
	it("picks the first matching key per provider", () => {
		const providers = providersFromEnv({
			KLING_API_KEY: "k",
			ARK_API_KEY: "ark",
			BYTEPLUS_API_KEY: "ignored",
			GEMINI_API_KEY: " g ",
		});
		expect(Object.keys(providers).sort()).toEqual([
			"byteplus",
			"google",
			"kling",
		]);
		expect(providers.byteplus?.apiKey).toBe("ark");
	});
});

describe("run", () => {
	it("prints help with no command", async () => {
		const { sink, stdout } = io();
		const code = await run([], sink, () => fakeClient());
		expect(code).toBe(0);
		expect(stdout.join("\n")).toContain("brotu video");
	});

	it("refuses to build a client without a Brotu key", async () => {
		const { sink, stderr } = io();
		const code = await run(["models"], sink, undefined, {});
		expect(code).toBe(1);
		expect(stderr.join("\n")).toContain("BROTU_API_KEY");
	});

	it("builds with only a Brotu key", async () => {
		const { sink, stdout } = io();
		const code = await run(["models"], sink, () => fakeClient(), {
			BROTU_API_KEY: "brotu_sk_test",
		});
		expect(code).toBe(0);
		expect(stdout.join("\n")).toContain("kling/v2-6");
	});

	it("lists models from the client", async () => {
		const { sink, stdout } = io();
		const code = await run(["models"], sink, () => fakeClient(), {
			BROTU_API_KEY: "brotu_sk_test",
			KLING_API_KEY: "k",
		});
		expect(code).toBe(0);
		expect(stdout.join("\n")).toContain("kling/v2-6");
	});

	it("submits video and writes a job file", async () => {
		const dir = await mkdtemp(join(tmpdir(), "brotu-cli-"));
		const out = join(dir, "job.json");
		const { sink, stdout } = io();
		try {
			const code = await run(
				["video", "a cat", "-m", "kling/v2-6", "--out", out],
				sink,
				() => fakeClient(),
				{ KLING_API_KEY: "k" },
			);
			expect(code).toBe(0);
			expect(stdout).toEqual([out]);
			const job = JSON.parse(await readFile(out, "utf8")) as Job;
			expect(job.id).toBe("task-1");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("waits a stored job", async () => {
		const dir = await mkdtemp(join(tmpdir(), "brotu-cli-"));
		const file = join(dir, "job.json");
		await writeFile(file, JSON.stringify(JOB));
		const { sink, stdout } = io();
		try {
			const code = await run(["job", "wait", file], sink, () => fakeClient(), {
				KLING_API_KEY: "k",
			});
			expect(code).toBe(0);
			expect(stdout[0]).toBe("https://cdn.example/out.mp4");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe("saveOutput", () => {
	it("decodes a data URI", async () => {
		const dir = await mkdtemp(join(tmpdir(), "brotu-cli-"));
		const dest = join(dir, "out.bin");
		try {
			await saveOutput(
				`data:text/plain;base64,${Buffer.from("hi").toString("base64")}`,
				dest,
			);
			expect(await readFile(dest, "utf8")).toBe("hi");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
