import type { GenerationOutput } from "../ports/content-generator.port";

export type AIErrorCode =
	/** The model id is not in the catalog. */
	| "unknown_model"
	/** The model's provider has no API key configured on this client. */
	| "missing_key"
	/** No adapter ships for that provider. */
	| "unsupported_provider"
	/** The request never made sense — wrong params for this model. */
	| "invalid_request"
	/** The provider accepted it and then failed, or rejected it outright. */
	| "provider_error"
	/** The job outlived the wait. It may still finish; poll it again later. */
	| "timeout";

export interface AIError {
	code: AIErrorCode;
	message: string;
	provider?: string;
	model?: string;
	/** Whatever the provider actually said, for logging. */
	cause?: unknown;
}

/**
 * Every public call returns this. Nothing throws.
 *
 * Errors that arrive as values are errors you cannot forget to handle: the type
 * makes `data` unusable until you have narrowed on `error`. It also removes a
 * whole class of bug this SDK hit repeatedly while being built — a rejection
 * thrown synchronously instead of returned, slipping past the caller's catch.
 */
export type Result<T> =
	| { data: T; error: null }
	| { data: null; error: AIError };

export function ok<T>(data: T): Result<T> {
	return { data, error: null };
}

export function fail<T>(error: AIError): Result<T> {
	return { data: null, error };
}

/** Turn a thrown value into an error result, since adapters may still throw. */
export function failFrom<T>(
	code: AIErrorCode,
	cause: unknown,
	context?: { provider?: string; model?: string },
): Result<T> {
	return fail({
		code,
		message: cause instanceof Error ? cause.message : String(cause),
		cause,
		...context,
	});
}

/** A finished generation. Success is the envelope's job, not a field in here. */
export interface Generation {
	outputs: GenerationOutput[];
	provider: string;
	model: string;
	processingTimeMs: number;
	/** The tags the request carried, handed straight back. */
	metadata?: Record<string, string>;
}
