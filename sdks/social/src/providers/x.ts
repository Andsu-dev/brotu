import {
	fail,
	failFrom,
	inferMediaType,
	type OAuthFlow,
	type OAuthToken,
	ok,
	type PostResult,
	type Result,
	type SocialProvider,
} from "../types";

const API = "https://api.x.com/2";

export interface XOptions {
	accessToken?: string;
	/** For the OAuth2 dance. X requires PKCE, so keep the verifier around. */
	clientId?: string;
	clientSecret?: string;
	redirectUri?: string;
	/** How long to wait for X to finish processing an uploaded video. */
	processingTimeoutMs?: number;
	baseUrl?: string;
}

/**
 * X, formerly Twitter. Text posts in one call; media goes through the chunked
 * upload, which is three calls plus a wait X asks for.
 */
export function x(options: XOptions = {}): SocialProvider {
	const api = (options.baseUrl ?? API).replace(/\/$/, "");
	const timeoutMs = options.processingTimeoutMs ?? 180_000;

	function auth(): string {
		if (!options.accessToken) {
			throw Object.assign(new Error("No X access token was configured."), {
				authError: true,
			});
		}
		return `Bearer ${options.accessToken}`;
	}

	async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
		const response = await fetch(`${api}${path}`, {
			...init,
			headers: {
				Authorization: auth(),
				...(init.body && !(init.body instanceof FormData)
					? { "Content-Type": "application/json" }
					: {}),
				...(init.headers as Record<string, string>),
			},
		});
		const text = await response.text();
		const body = safeJson(text) as {
			detail?: string;
			title?: string;
			errors?: Array<{ message?: string }>;
		};
		if (!response.ok) {
			throw Object.assign(
				new Error(
					body?.detail ||
						body?.errors?.[0]?.message ||
						text ||
						`X ${response.status}`,
				),
				{
					status: response.status,
					authError: response.status === 401 || response.status === 403,
					rateLimited: response.status === 429,
					retryAfterSeconds:
						Number(response.headers.get("retry-after")) || undefined,
					cause: body,
				},
			);
		}
		return body as T;
	}

	/** INIT, APPEND in 5MB slices, FINALIZE, then wait if X says to. */
	async function uploadMedia(
		url: string,
		type: "image" | "video",
	): Promise<string> {
		const media = await fetch(url);
		if (!media.ok) {
			throw Object.assign(
				new Error(`Could not fetch ${url}: ${media.status}`),
				{
					invalid: true,
				},
			);
		}
		const bytes = new Uint8Array(await media.arrayBuffer());
		const mimeType =
			media.headers.get("content-type") ??
			(type === "video" ? "video/mp4" : "image/jpeg");

		const init = await call<{ data?: { id?: string } }>("/media/upload", {
			method: "POST",
			body: JSON.stringify({
				media_type: mimeType,
				total_bytes: bytes.byteLength,
				media_category: type === "video" ? "tweet_video" : "tweet_image",
			}),
		});
		const mediaId = init.data?.id;
		if (!mediaId) throw new Error("X started an upload without a media id.");

		const CHUNK = 5 * 1024 * 1024;
		for (let segment = 0, offset = 0; offset < bytes.byteLength; segment++) {
			const chunk = bytes.subarray(offset, offset + CHUNK);
			const form = new FormData();
			form.set("media", new Blob([chunk]));
			form.set("segment_index", String(segment));
			await call(`/media/upload/${mediaId}/append`, {
				method: "POST",
				body: form,
			});
			offset += CHUNK;
		}

		const finalized = await call<{
			data?: {
				processing_info?: { state?: string; check_after_secs?: number };
			};
		}>(`/media/upload/${mediaId}/finalize`, { method: "POST" });

		let info = finalized.data?.processing_info;
		const deadline = Date.now() + timeoutMs;
		while (info && (info.state === "pending" || info.state === "in_progress")) {
			if (Date.now() >= deadline) {
				throw Object.assign(
					new Error(`X was still processing ${mediaId} after the timeout.`),
					{ timedOut: true },
				);
			}
			// X tells you how long to wait; ignoring it is how you get rate limited.
			await new Promise((resolve) =>
				setTimeout(resolve, (info?.check_after_secs ?? 3) * 1000),
			);
			const status = await call<{
				data?: {
					processing_info?: { state?: string; check_after_secs?: number };
				};
			}>(`/media/upload?media_id=${mediaId}&command=STATUS`);
			info = status.data?.processing_info;
			if (info?.state === "failed") {
				throw new Error(`X failed to process ${mediaId}.`);
			}
		}

		return mediaId;
	}

	return {
		name: "x",
		platforms: ["x"],

		async publish(_platform, request): Promise<Result<PostResult>> {
			try {
				const extra = (request.options?.x ?? {}) as Record<string, unknown>;
				const urls = request.mediaUrls ?? [];

				const mediaIds: string[] = [];
				for (const [index, url] of urls.entries()) {
					const type = request.mediaTypes?.[index] ?? inferMediaType(url);
					mediaIds.push(await uploadMedia(url, type));
				}

				const created = await call<{ data?: { id?: string } }>("/tweets", {
					method: "POST",
					body: JSON.stringify({
						text: request.caption,
						...(mediaIds.length ? { media: { media_ids: mediaIds } } : {}),
						...(extra.replySetting
							? { reply_settings: extra.replySetting }
							: {}),
						...(extra.quoteTweetId
							? { quote_tweet_id: extra.quoteTweetId }
							: {}),
						...(extra.inReplyToTweetId
							? { reply: { in_reply_to_tweet_id: extra.inReplyToTweetId } }
							: {}),
						...(extra.poll ? { poll: extra.poll } : {}),
						...(extra.placeId ? { geo: { place_id: extra.placeId } } : {}),
					}),
				});

				const id = created.data?.id;
				if (!id) throw new Error("X accepted the post but returned no id.");
				return {
					data: {
						platform: "x",
						id,
						url: `https://x.com/i/status/${id}`,
					},
					error: null,
				};
			} catch (error) {
				const flags = error as {
					authError?: boolean;
					rateLimited?: boolean;
					invalid?: boolean;
					timedOut?: boolean;
					retryAfterSeconds?: number;
				};
				if (flags?.invalid)
					return failFrom("invalid_request", error, { platform: "x" });
				if (flags?.authError)
					return failFrom("auth_error", error, { platform: "x" });
				if (flags?.timedOut)
					return failFrom("timeout", error, { platform: "x" });
				if (flags?.rateLimited) {
					return fail({
						code: "rate_limited",
						message: error instanceof Error ? error.message : String(error),
						platform: "x",
						retryAfterSeconds: flags.retryAfterSeconds,
						cause: error,
					});
				}
				return failFrom("platform_error", error, { platform: "x" });
			}
		},

		async accounts() {
			try {
				const me = await call<{
					data?: { id?: string; username?: string; name?: string };
				}>("/users/me");
				if (!me.data?.id) return ok([]);
				return ok([
					{
						platform: "x" as const,
						id: me.data.id,
						username: me.data.username,
						displayName: me.data.name,
					},
				]);
			} catch (error) {
				return failFrom("platform_error", error, { platform: "x" });
			}
		},

		oauth(): OAuthFlow | undefined {
			if (!options.clientId) return undefined;
			const clientId = options.clientId;

			async function token(
				params: Record<string, string>,
			): Promise<Result<OAuthToken>> {
				try {
					const response = await fetch("https://api.x.com/2/oauth2/token", {
						method: "POST",
						headers: {
							"Content-Type": "application/x-www-form-urlencoded",
							// A confidential client authenticates with Basic; a public
							// one sends client_id in the body and no header.
							...(options.clientSecret
								? {
										Authorization: `Basic ${Buffer.from(
											`${clientId}:${options.clientSecret}`,
										).toString("base64")}`,
									}
								: {}),
						},
						body: new URLSearchParams(params),
					});
					const text = await response.text();
					const body = safeJson(text) as {
						access_token?: string;
						expires_in?: number;
						refresh_token?: string;
						scope?: string;
						error_description?: string;
					};
					if (!response.ok || !body.access_token) {
						return fail({
							code: "auth_error",
							message: body.error_description || text || `X ${response.status}`,
							platform: "x",
							cause: body,
						});
					}
					return ok({
						accessToken: body.access_token,
						expiresIn: body.expires_in,
						refreshToken: body.refresh_token,
						scopes: body.scope?.split(" "),
					});
				} catch (error) {
					return failFrom("auth_error", error, { platform: "x" });
				}
			}

			return {
				authUrl({ state, redirectUri }) {
					const url = new URL("https://x.com/i/oauth2/authorize");
					url.searchParams.set("response_type", "code");
					url.searchParams.set("client_id", clientId);
					url.searchParams.set(
						"redirect_uri",
						redirectUri ?? options.redirectUri ?? "",
					);
					// offline.access is what gets you a refresh token.
					url.searchParams.set(
						"scope",
						"tweet.read tweet.write users.read media.write offline.access",
					);
					url.searchParams.set("state", state);
					// X requires PKCE. `plain` keeps this synchronous; pass your own
					// verifier to `exchange` and use S256 if your stack can hash here.
					url.searchParams.set("code_challenge", state);
					url.searchParams.set("code_challenge_method", "plain");
					return url.toString();
				},

				exchange({ code, redirectUri, codeVerifier }) {
					return token({
						grant_type: "authorization_code",
						code,
						client_id: clientId,
						redirect_uri: redirectUri ?? options.redirectUri ?? "",
						// Defaults to the state, matching the challenge authUrl sent.
						code_verifier: codeVerifier ?? "",
					});
				},

				refresh({ token: refreshToken }) {
					return token({
						grant_type: "refresh_token",
						refresh_token: refreshToken,
						client_id: clientId,
					});
				},
			};
		},
	};
}

function safeJson(text: string): unknown {
	try {
		return text ? JSON.parse(text) : {};
	} catch {
		return text;
	}
}
