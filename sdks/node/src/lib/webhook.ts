import type { AIError } from "../helpers/result";
import type {
	GenerationOutput,
	GenerationType,
} from "../ports/content-generator.port";

export type WebhookEventName = "generation.succeeded" | "generation.failed";

export interface WebhookConfig {
	url: string;
	/** Sent as `x-brotu-webhook-secret` so your endpoint can reject strangers. */
	secret?: string;
	headers?: Record<string, string>;
}

export interface WebhookEvent {
	event: WebhookEventName;
	jobId?: string;
	provider?: string;
	model?: string;
	kind?: GenerationType;
	outputs?: GenerationOutput[];
	error?: Pick<AIError, "code" | "message">;
	metadata?: Record<string, string>;
	processingTimeMs?: number;
	completedAt: string;
}

export function resolveWebhook(
	value: string | WebhookConfig | undefined,
): WebhookConfig | undefined {
	if (!value) return undefined;
	if (typeof value === "string") {
		return isHttpUrl(value) ? { url: value } : undefined;
	}
	if (!isHttpUrl(value.url)) return undefined;
	return {
		url: value.url,
		secret: value.secret,
		headers: value.headers,
	};
}

function isHttpUrl(value: string): boolean {
	try {
		const parsed = new URL(value);
		return parsed.protocol === "https:" || parsed.protocol === "http:";
	} catch {
		return false;
	}
}

/**
 * POST the settled generation at the registered URL. Failures are swallowed:
 * a down hook must not fail the call the user is waiting on.
 */
export async function deliverWebhook(
	config: WebhookConfig,
	payload: WebhookEvent,
): Promise<void> {
	try {
		await fetch(config.url, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"user-agent": "@brotu/ai",
				"x-brotu-event": payload.event,
				...(config.secret
					? { "x-brotu-webhook-secret": config.secret }
					: {}),
				...config.headers,
			},
			body: JSON.stringify(payload),
			signal: AbortSignal.timeout(10_000),
		});
	} catch {
		// Best-effort.
	}
}
