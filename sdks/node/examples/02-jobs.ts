/**
 * Jobs: the shape that survives a process dying.
 *
 * A video takes minutes. A serverless function does not. So the primary API is
 * submit-then-poll, and the handle is plain JSON you can put in a database.
 */
import { brotuClient, type Job } from "../src";

const ai = brotuClient({
	apiKey: process.env.BROTU_API_KEY ?? "",
	providers: { qwen: { apiKey: process.env.QWEN_API_KEY ?? "" } },
	// When wait/poll settles, POST the result here. A down hook never fails the job.
	webhook: process.env.BROTU_WEBHOOK_URL,
});

// ---------------------------------------------------------------- request handler

export async function startRender(prompt: string) {
	const { data: job, error } = await ai.video.submit({
		model: "wan2.7-t2v",
		prompt,
		duration: 5,
		resolution: "720P",
	});

	if (error) return { ok: false as const, reason: error.message };

	// Serializable: id, provider, model, kind, pollEndpoint, params.
	await saveJob(job);
	return { ok: true as const, jobId: job.id };
}

// ------------------------------------------------- a later invocation, minutes on

export async function checkRender(jobId: string) {
	const job = await loadJob(jobId);

	// One check. Returns straight away whether or not it has settled.
	const { data: snapshot, error } = await ai.jobs.poll(job);
	if (error) return { status: "failed" as const, reason: error.message };

	if (snapshot.status === "pending") return { status: "pending" as const };
	if (snapshot.status === "failed") {
		return { status: "failed" as const, reason: snapshot.error };
	}

	return {
		status: "done" as const,
		url: snapshot.result?.outputs[0]?.url,
	};
}

// ------------------------------------------------------------- a worker, blocking

export async function renderInWorker(prompt: string) {
	const { data: job, error: submitError } = await ai.video.submit({
		model: "wan2.7-t2v",
		prompt,
	});
	if (submitError) throw new Error(submitError.message);

	// Polls until it settles or the timeout passes.
	const { data, error } = await ai.jobs.wait(job, { timeoutMs: 10 * 60_000 });

	if (error) {
		// A timeout is not a dead end — the job may still be running, so the
		// handle stays valid and you can come back to it.
		if (error.code === "timeout") {
			await saveJob(job);
			return { retryLater: true };
		}
		throw new Error(error.message);
	}

	return { url: data.outputs[0]?.url };
}

// Stand-ins for whatever you actually persist with.
declare function saveJob(job: Job): Promise<void>;
declare function loadJob(id: string): Promise<Job>;
