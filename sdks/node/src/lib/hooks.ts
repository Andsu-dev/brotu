import type { AIError } from "../helpers/result";
import type {
	GenerationOutput,
	GenerationType,
} from "../ports/content-generator.port";

/** Where a generation is when the hook fires. */
export type HookStage = "Loading" | "Success" | "Error";

/** What every hook receives. Fields absent at that stage stay undefined. */
export interface HookEvent {
	kind: GenerationType;
	stage: HookStage;
	provider: string;
	model: string;
	jobId?: string;
	outputs?: GenerationOutput[];
	error?: Pick<AIError, "code" | "message">;
	metadata?: Record<string, string>;
	processingTimeMs?: number;
	at: string;
}

export type HookFn = (event: HookEvent) => void | Promise<void>;

/**
 * One optional callback per kind and stage — `onVideoLoading`,
 * `onImageSuccess`, `onAudioError`, and so on for every combination.
 */
export type Hooks = Partial<
	Record<`on${Capitalize<GenerationType>}${HookStage}`, HookFn>
>;

function hookName(kind: GenerationType, stage: HookStage) {
	return `on${kind[0].toUpperCase()}${kind.slice(1)}${stage}` as keyof Hooks;
}

/** The hook registered for this kind and stage, if any. */
export function findHook(
	hooks: Hooks | undefined,
	kind: GenerationType | undefined,
	stage: HookStage,
): HookFn | undefined {
	if (!hooks || !kind) return undefined;
	return hooks[hookName(kind, stage)];
}

/**
 * Run a hook without letting it break the caller. Same contract as the
 * webhook: your logging or your mailer going down must not fail a generation
 * that already succeeded.
 */
export async function runHook(
	hook: HookFn | undefined,
	event: HookEvent,
): Promise<void> {
	if (!hook) return;
	try {
		await hook(event);
	} catch {
		// Best-effort.
	}
}
