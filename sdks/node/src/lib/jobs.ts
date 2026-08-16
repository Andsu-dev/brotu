import { AsyncLocalStorage } from "node:async_hooks";
import type {
	GenerationParams,
	GenerationResult,
	GenerationType,
} from "../ports/content-generator.port";

/**
 * A submitted generation, in a shape you can put in a database.
 *
 * It carries the params because pricing and output shaping are derived from them,
 * and a process that resumes this job days later has nothing else to go on.
 */
export interface Job {
	id: string;
	provider: string;
	model: string;
	kind: GenerationType;
	/** Provider-specific path used to ask about this job. */
	pollEndpoint?: string;
	params: GenerationParams;
	/** Whatever the caller tagged the request with. */
	metadata?: Record<string, string>;
	/** Set when the provider answered immediately instead of queueing. */
	result?: GenerationResult;
	submittedAt: string;
}

export type JobStatus = "pending" | "succeeded" | "failed";

export interface JobSnapshot {
	status: JobStatus;
	/** Present once the job is no longer pending. */
	result?: GenerationResult;
	error?: string;
}

/**
 * Thrown to unwind a generation call the moment the provider hands back a task
 * id, so `submit` gets the handle without waiting for the result.
 *
 * ponytail: a control-flow throw beats threading a flag through ten polling
 * sites and four method bodies that retry around them. The cost is the seven
 * catch blocks in the adapter, which must re-raise it — `isPendingJob` exists so
 * they can, and so can yours if you wrap adapter calls.
 */
export class PendingJob extends Error {
	readonly taskId: string;
	readonly pollEndpoint?: string;

	constructor(taskId: string, pollEndpoint?: string) {
		super(`Job ${taskId} was submitted and is still running.`);
		this.name = "PendingJob";
		this.taskId = taskId;
		this.pollEndpoint = pollEndpoint;
	}
}

export function isPendingJob(error: unknown): error is PendingJob {
	return error instanceof PendingJob;
}

/** Active only inside `submit`, and only on the calling async context. */
const submitMode = new AsyncLocalStorage<true>();

export function runInSubmitMode<T>(fn: () => Promise<T>): Promise<T> {
	return submitMode.run(true, fn);
}

export function isSubmitMode(): boolean {
	return submitMode.getStore() === true;
}
