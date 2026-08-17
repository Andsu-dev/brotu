import { readFile, writeFile } from "node:fs/promises";
import {
	type BrotuAI,
	brotu,
	type Generation,
	type GenerationType,
	type ImageGenerationParams,
	type Job,
	type VideoGenerationParams,
} from "@brotu/ai";
import { flagBool, flagNumber, flagString, parseArgs } from "./args";
import {
	brotuApiKey,
	brotuApiUrl,
	brotuWorkspaceId,
	describeExpectedKeys,
	providersFromEnv,
} from "./env";
import { HELP } from "./help";
import { saveOutput } from "./save";

export interface CliIo {
	stdout: (line: string) => void;
	stderr: (line: string) => void;
}

export type ClientFactory = (env: NodeJS.ProcessEnv) => BrotuAI;

const DEFAULT_JOB_FILE = "brotu-job.json";
const DEFAULT_WAIT_MS = 420_000;

export function defaultClientFactory(
	env: NodeJS.ProcessEnv = process.env,
): BrotuAI {
	const apiKey = brotuApiKey(env);
	if (!apiKey) {
		throw new Error(
			`Pass BROTU_API_KEY. Get one at https://brotu.app\n${describeExpectedKeys()}`,
		);
	}

	const webhookUrl = env.BROTU_WEBHOOK_URL?.trim();
	const webhookSecret = env.BROTU_WEBHOOK_SECRET?.trim();

	return brotu({
		apiKey,
		apiUrl: brotuApiUrl(env),
		workspaceId: brotuWorkspaceId(env),
		providers: providersFromEnv(env),
		elevenLabsVoiceId: env.ELEVENLABS_VOICE_ID?.trim(),
		webhook: webhookUrl
			? webhookSecret
				? { url: webhookUrl, secret: webhookSecret }
				: webhookUrl
			: undefined,
	});
}

function requireModel(flags: Record<string, string | boolean>): string {
	const model = flagString(flags, "model");
	if (!model) {
		throw new Error("Pass -m / --model with a catalog id.");
	}
	return model;
}

function requirePrompt(positionals: string[]): string {
	const prompt = positionals.join(" ").trim();
	if (!prompt) {
		throw new Error("Pass a prompt.");
	}
	return prompt;
}

function printJson(io: CliIo, value: unknown): void {
	io.stdout(JSON.stringify(value, null, 2));
}

function printError(io: CliIo, error: { code?: string; message: string }): void {
	io.stderr(error.code ? `${error.code}: ${error.message}` : error.message);
}

async function writeJob(path: string, job: Job): Promise<void> {
	await writeFile(path, `${JSON.stringify(job, null, 2)}\n`, "utf8");
}

async function readJob(path: string): Promise<Job> {
	const raw = await readFile(path, "utf8");
	return JSON.parse(raw) as Job;
}

async function maybeSave(
	generation: Generation,
	savePath: string | undefined,
	io: CliIo,
): Promise<void> {
	if (!savePath) return;
	const url = generation.outputs[0]?.url;
	if (!url) {
		throw new Error("The generation settled with no output URL to save.");
	}
	await saveOutput(url, savePath);
	io.stderr(`saved ${savePath}`);
}

function printGeneration(
	io: CliIo,
	generation: Generation,
	asJson: boolean,
): void {
	if (asJson) {
		printJson(io, generation);
		return;
	}
	const url = generation.outputs[0]?.url ?? "(no output)";
	const text = generation.outputs[0]?.raw?.text;
	if (typeof text === "string" && text.length > 0) {
		io.stdout(text);
		return;
	}
	io.stdout(url);
	io.stderr(
		`${generation.provider} · ${generation.model} · ${generation.processingTimeMs}ms`,
	);
}

export async function run(
	argv: string[],
	io: CliIo = { stdout: console.log, stderr: console.error },
	createClient: ClientFactory = defaultClientFactory,
	env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
	const parsed = parseArgs(argv);

	if (
		!parsed.command ||
		parsed.command === "help" ||
		flagBool(parsed.flags, "help")
	) {
		io.stdout(HELP.trimEnd());
		return 0;
	}

	const asJson = flagBool(parsed.flags, "json");
	const webhook = flagString(parsed.flags, "webhook");

	try {
		if (parsed.command === "models") {
			const ai = createClient(env);
			const type = flagString(parsed.flags, "type");
			const models = ai
				.models()
				.filter((model) => !type || model.category === type)
				.map((model) => ({
					id: model.id,
					name: model.name,
					category: model.category,
					provider: model.provider,
				}));
			if (asJson) {
				printJson(io, models);
				return 0;
			}
			if (models.length === 0) {
				io.stderr("No models for the configured keys.");
				return 1;
			}
			for (const model of models) {
				io.stdout(
					`${model.id.padEnd(32)} ${(model.category ?? "").padEnd(6)} ${model.provider ?? ""}`,
				);
			}
			return 0;
		}

		if (parsed.command === "cost") {
			const kind = parsed.positionals[0] as GenerationType | undefined;
			if (
				kind !== "video" &&
				kind !== "image" &&
				kind !== "audio" &&
				kind !== "text"
			) {
				throw new Error("cost needs a kind: video, image, audio or text.");
			}
			const ai = createClient(env);
			const model = requireModel(parsed.flags);
			const { data, error } = await ai.estimateCost(kind, {
				model,
				prompt: parsed.positionals.slice(1).join(" ") || "x",
				duration: flagNumber(parsed.flags, "duration"),
				resolution: flagString(parsed.flags, "resolution"),
				aspectRatio: flagString(parsed.flags, "aspect"),
			});
			if (error) {
				printError(io, error);
				return 1;
			}
			if (asJson) {
				printJson(io, data);
				return 0;
			}
			const usd = data.usd === null ? "usd unknown" : `$${data.usd.toFixed(4)}`;
			io.stdout(`${data.units} ${data.unit} · ${usd} · ${data.model}`);
			if (data.note) io.stderr(data.note);
			return 0;
		}

		if (parsed.command === "job") {
			const file = parsed.positionals[0];
			if (!file) throw new Error("Pass the job file: brotu job wait job.json");
			const job = await readJob(file);
			const ai = createClient(env);

			if (parsed.subcommand === "poll") {
				const { data, error } = await ai.jobs.poll(job);
				if (error) {
					printError(io, error);
					return 1;
				}
				if (asJson) {
					printJson(io, data);
					return 0;
				}
				io.stdout(data.status);
				if (data.status === "succeeded") {
					io.stdout(data.result?.outputs[0]?.url ?? "");
				}
				if (data.status === "failed" && data.error) io.stderr(data.error);
				return data.status === "failed" ? 1 : 0;
			}

			if (parsed.subcommand !== "wait") {
				throw new Error("Unknown job command. Use: brotu job wait|poll <file>");
			}

			const { data, error } = await ai.jobs.wait(job, {
				timeoutMs: flagNumber(parsed.flags, "timeout") ?? DEFAULT_WAIT_MS,
			});
			if (error) {
				printError(io, error);
				return 1;
			}
			await maybeSave(data, flagString(parsed.flags, "save"), io);
			printGeneration(io, data, asJson);
			return 0;
		}

		if (
			parsed.command !== "video" &&
			parsed.command !== "image" &&
			parsed.command !== "audio" &&
			parsed.command !== "text"
		) {
			throw new Error(`Unknown command "${parsed.command}". Try brotu --help.`);
		}

		const ai = createClient(env);
		const model = requireModel(parsed.flags);
		const videoUrl = flagString(parsed.flags, "video");
		const imageUrl = flagString(parsed.flags, "image");
		const prompt =
			(parsed.command === "video" && videoUrl) ||
			(parsed.command === "image" && imageUrl)
				? parsed.positionals.join(" ").trim()
				: requirePrompt(parsed.positionals);
		const wait = flagBool(parsed.flags, "wait");
		const out = flagString(parsed.flags, "out") ?? DEFAULT_JOB_FILE;

		if (parsed.command === "video") {
			const params: VideoGenerationParams = {
				model,
				prompt,
				duration: flagNumber(parsed.flags, "duration"),
				aspectRatio: flagString(parsed.flags, "aspect"),
				resolution: flagString(parsed.flags, "resolution"),
				imageUrl: flagString(parsed.flags, "image"),
				videoUrl,
				webhook,
			};

			if (wait) {
				const { data, error } = await ai.video.generate(params);
				if (error) {
					printError(io, error);
					return 1;
				}
				await maybeSave(data, flagString(parsed.flags, "save"), io);
				printGeneration(io, data, asJson);
				return 0;
			}

			const { data, error } = await ai.video.submit(params);
			if (error) {
				printError(io, error);
				return 1;
			}
			await writeJob(out, data);
			if (asJson) {
				printJson(io, data);
			} else {
				io.stdout(out);
				io.stderr(`submitted ${data.id} · brotu job wait ${out}`);
			}
			return 0;
		}

		if (parsed.command === "image") {
			const quality = flagString(parsed.flags, "quality");
			const params: ImageGenerationParams = {
				model,
				prompt,
				aspectRatio: flagString(parsed.flags, "aspect"),
				resolution: flagString(parsed.flags, "resolution"),
				referenceImages: imageUrl ? [imageUrl] : undefined,
				quality:
					quality === "low" || quality === "medium" || quality === "high"
						? quality
						: undefined,
				webhook,
			};
			const { data, error } = await ai.image.generate(params);
			if (error) {
				printError(io, error);
				return 1;
			}
			await maybeSave(data, flagString(parsed.flags, "save"), io);
			printGeneration(io, data, asJson);
			return 0;
		}

		if (parsed.command === "audio") {
			const { data, error } = await ai.audio.generate({
				model,
				prompt,
				voice: flagString(parsed.flags, "voice"),
				webhook,
			});
			if (error) {
				printError(io, error);
				return 1;
			}
			await maybeSave(data, flagString(parsed.flags, "save"), io);
			printGeneration(io, data, asJson);
			return 0;
		}

		const { data, error } = await ai.text.generate({
			model,
			prompt,
			systemPrompt: flagString(parsed.flags, "system"),
			webhook,
		});
		if (error) {
			printError(io, error);
			return 1;
		}
		printGeneration(io, data, asJson);
		return 0;
	} catch (error) {
		printError(io, {
			message: error instanceof Error ? error.message : String(error),
		});
		return 1;
	}
}
