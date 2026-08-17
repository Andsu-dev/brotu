/** Every platform this SDK knows how to name. */
export const PLATFORMS = [
	"facebook",
	"instagram",
	"threads",
	"youtube",
	"tiktok",
	"x",
	"linkedin",
] as const;

export type Platform = (typeof PLATFORMS)[number];

export type SocialErrorCode =
	/** No provider was registered for that platform, and no Brotu key either. */
	| "unconfigured_platform"
	/** The request never made sense — missing media, caption too long, wrong type. */
	| "invalid_request"
	/** The credential is missing, expired or lacks the scope the call needs. */
	| "auth_error"
	/** The platform accepted it and then failed, or rejected it outright. */
	| "platform_error"
	/** The platform is rate limiting. `retryAfterSeconds` says for how long. */
	| "rate_limited"
	/** The upload or the publish outlived the wait. It may still land. */
	| "timeout"
	/** The provider is registered but cannot do this on its own yet. */
	| "unsupported";

export interface SocialError {
	code: SocialErrorCode;
	message: string;
	platform?: Platform;
	retryAfterSeconds?: number;
	/** Whatever the platform actually said, for logging. */
	cause?: unknown;
}

/**
 * Every public call returns this. Nothing throws.
 *
 * Same envelope as `@brotu/ai`, deliberately: a project using both should not
 * have to remember which one throws.
 */
export type Result<T> =
	| { data: T; error: null }
	| { data: null; error: SocialError };

export function ok<T>(data: T): Result<T> {
	return { data, error: null };
}

export function fail<T>(error: SocialError): Result<T> {
	return { data: null, error };
}

export function failFrom<T>(
	code: SocialErrorCode,
	cause: unknown,
	context?: { platform?: Platform },
): Result<T> {
	return fail({
		code,
		message: cause instanceof Error ? cause.message : String(cause),
		cause,
		...context,
	});
}

export type MediaType = "image" | "video";

/** What every platform is asked for, whatever it calls the fields. */
export interface PostRequest {
	/** The text. Platforms that separate title from body read `title` too. */
	caption: string;
	/** Public URLs. The platform fetches them, so they must be reachable. */
	mediaUrls?: string[];
	/** Inferred from the URL extension when omitted. */
	mediaTypes?: MediaType[];
	/** Required by YouTube, ignored by the platforms that have no such field. */
	title?: string;
	/** Anything one platform alone understands. Never sent to another. */
	options?: Partial<Record<Platform, Record<string, unknown>>>;
	/** Your own tags, carried through and handed back. Never sent anywhere. */
	metadata?: Record<string, string>;
}

export interface PostResult {
	platform: Platform;
	/** The platform's own id for what was published. */
	id: string;
	/** Link to the post, when the platform hands one back. */
	url?: string;
}

/** One connected account a provider can publish as. */
export interface Account {
	platform: Platform;
	id: string;
	username?: string;
	displayName?: string;
}

/** The three calls an OAuth dance needs, whoever is doing it. */
export interface OAuthFlow {
	/**
	 * Where to send the user. `state` comes back on the callback — generate it
	 * yourself and check it, or CSRF is on you.
	 */
	authUrl(input: { state: string; redirectUri?: string }): string;
	/** The callback's `code`, traded for a token. */
	exchange(input: {
		code: string;
		redirectUri?: string;
		codeVerifier?: string;
	}): Promise<Result<OAuthToken>>;
	/** A longer-lived token from a short one, where the platform offers it. */
	refresh(input: { token: string }): Promise<Result<OAuthToken>>;
}

export interface OAuthToken {
	accessToken: string;
	/** Seconds from now. Absent when the platform does not say. */
	expiresIn?: number;
	refreshToken?: string;
	scopes?: string[];
}

/**
 * A provider plugin — what `meta({…})` and `youtube({…})` return.
 *
 * A plugin owns one credential and the platforms that credential reaches, so
 * Meta's three sit in one plugin and YouTube in another. The client only ever
 * sees this shape.
 */
export interface SocialProvider {
	/** Name of the plugin itself, for errors. */
	readonly name: string;
	/** Platforms it serves. Each becomes a namespace on the client. */
	readonly platforms: readonly Platform[];
	/** Publish on the platform directly. Absent means "only Brotu can". */
	publish?(
		platform: Platform,
		request: PostRequest,
	): Promise<Result<PostResult>>;
	/** Accounts this credential can publish as. */
	accounts?(platform: Platform): Promise<Result<Account[]>>;
	/** The OAuth dance for this platform, when the plugin can run it. */
	oauth?(platform: Platform): OAuthFlow | undefined;
	/** How to verify and read this platform's webhooks. */
	webhooks?: WebhookVerifier;
}

/** What arrives when a platform calls your endpoint. */
export interface WebhookEvent {
	platform: Platform;
	/** Normalised name, e.g. `comment.created`. `raw` has the platform's own. */
	type: string;
	/** The object it happened to — a post id, a media id. */
	objectId?: string;
	receivedAt: string;
	raw: unknown;
}

export interface WebhookVerifier {
	/**
	 * Answer the platform's subscription challenge, if it does that handshake.
	 * Returns the body to echo, or undefined when this is not a challenge.
	 */
	challenge?(query: Record<string, string>): string | undefined;
	/**
	 * Check the signature against the raw body. Pass the body as the exact
	 * bytes received — parsing first and re-serialising changes them, and the
	 * signature stops matching.
	 */
	verify(input: {
		rawBody: string;
		headers: Record<string, string>;
	}): Result<true>;
	/** Turn a verified body into events. */
	parse(rawBody: string): Result<WebhookEvent[]>;
}

/** Guess from the URL, so the common case needs no `mediaTypes`. */
export function inferMediaType(url: string): MediaType {
	const path = url.split("?")[0]?.toLowerCase() ?? "";
	return /\.(mp4|mov|m4v|webm|avi|mkv)$/.test(path) ? "video" : "image";
}
