import { describe, expect, it } from "bun:test";
import {
	isPendingJob,
	isSubmitMode,
	type Job,
	PendingJob,
	runInSubmitMode,
} from "../lib/jobs";

describe("submit mode", () => {
	it("is off outside a submit", () => {
		expect(isSubmitMode()).toBe(false);
	});

	it("is on inside one, and off again after", async () => {
		let seen = false;
		await runInSubmitMode(async () => {
			seen = isSubmitMode();
		});
		expect(seen).toBe(true);
		expect(isSubmitMode()).toBe(false);
	});

	it("does not leak into a concurrent call that is not submitting", async () => {
		let insideOther = true;
		const other = (async () => {
			await new Promise((r) => setTimeout(r, 5));
			insideOther = isSubmitMode();
		})();

		await runInSubmitMode(async () => {
			await new Promise((r) => setTimeout(r, 10));
		});
		await other;

		expect(insideOther).toBe(false);
	});

	it("survives an await inside the submitted call", async () => {
		const seen = await runInSubmitMode(async () => {
			await new Promise((r) => setTimeout(r, 5));
			return isSubmitMode();
		});
		expect(seen).toBe(true);
	});
});

describe("PendingJob", () => {
	it("carries the handle out of the generation call", () => {
		const error = new PendingJob("task-1", "/tasks/task-1");
		expect(isPendingJob(error)).toBe(true);
		expect(error.taskId).toBe("task-1");
		expect(error.pollEndpoint).toBe("/tasks/task-1");
	});

	it("is not confused with an ordinary failure", () => {
		expect(isPendingJob(new Error("boom"))).toBe(false);
	});

	it("survives the round trip a caller would do to store it", () => {
		const job: Job = {
			id: "task-1",
			provider: "kie",
			model: "veo3_fast",
			kind: "video",
			pollEndpoint: "/veo/record-info?taskId=task-1",
			params: { prompt: "a cat", duration: 8, resolution: "1080p" },
			submittedAt: new Date(0).toISOString(),
		};

		const restored = JSON.parse(JSON.stringify(job)) as Job;
		expect(restored).toEqual(job);
	});
});
