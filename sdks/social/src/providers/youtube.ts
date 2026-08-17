import {
	fail,
	failFrom,
	type OAuthFlow,
	type OAuthToken,
	ok,
	type PostRequest,
	type PostResult,
	type Result,
	type SocialProvider,
} from "../types";

const API = "https://www.googleapis.com/youtube/v3";
const UPLOAD = "https://www.googleapis.com/upload/youtube/v3";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

export interface YouTubeOptions {
	/** A current access token. Skip it and pass `refreshToken` instead. */
	accessToken?: string;
	/**
	 * The long-lived credential. With `clientId` and `clientSecret` the plugin
	 * mints an access token itself, so you never hold a fresh one.
	 */
	refreshToken?: string;
	clientId?: string;
	clientSecret?: string;
	redirectUri?: string;
	/** Override for tests. */
	baseUrl?: string;
	uploadUrl?: string;
}

interface GoogleError {
	error?: { message?: string; errors?: Array<{ reason?: string }> };
}

/**
 * YouTube. One plugin, one channel — the channel is whichever the token
 * belongs to, which is how Google models it.
 */
export function youtube(options: YouTubeOptions = {}): SocialProvider {
	const api = (options.baseUrl ?? API).replace(/\/$/, "");
	const upload = (options.uploadUrl ?? options.baseUrl ?? UPLOAD).replace(
		/\/$/,
		"",
	);

	let cached: { token: string; expiresAt: number } | undefined;

	/** A usable access token, minted from the refresh token when needed. */
	async function token(): Promise<string> {
		if (options.accessToken) return options.accessToken;
		if (cached && cached.expiresAt > Date.now() + 30_000) return cached.token;

		if (!options.refreshToken || !options.clientId || !options.clientSecret) {
			throw Object.assign(
				new Error(
					"Pass youtube({ accessToken }) or ({ refreshToken, clientId, clientSecret }).",
				),
				{ authError: true },
			);
		}

		const response = await fetch(TOKEN_URL, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				grant_type: "refresh_token",
				refresh_token: options.refreshToken,
				client_id: options.clientId,
				client_secret: options.clientSecret,
			}),
		});
		const body = (await response.json()) as {
			access_token?: string;
			expires_in?: number;
		};
		if (!response.ok || !body.access_token) {
			throw Object.assign(new Error("Could not refresh the YouTube token."), {
				authError: true,
				cause: body,
			});
		}
		cached = {
			token: body.access_token,
			expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000,
		};
		return cached.token;
	}

	function fromResponse(status: number, body: unknown, text: string): Error {
		const google = (body as GoogleError)?.error;
		const reason = google?.errors?.[0]?.reason;
		return Object.assign(
			new Error(google?.message || text || `YouTube ${status}`),
			{
				status,
				authError: status === 401 || reason === "authError",
				rateLimited:
					status === 429 ||
					reason === "quotaExceeded" ||
					reason === "rateLimitExceeded",
				cause: body,
			},
		);
	}

	return {
		name: "youtube",
		platforms: ["youtube"],

		async publish(
			_platform,
			request: PostRequest,
		): Promise<Result<PostResult>> {
			const [url] = request.mediaUrls ?? [];
			if (!url) {
				return fail({
					code: "invalid_request",
					message: "YouTube publishes a video: pass one mediaUrl.",
					platform: "youtube",
				});
			}

			const extra = (request.options?.youtube ?? {}) as Record<string, unknown>;
			const title =
				request.title ??
				(extra.title as string | undefined) ??
				// A title is required, and the caption's first line is the only
				// sensible thing to fall back to.
				request.caption
					.split("\n")[0]
					?.slice(0, 100) ??
				"Untitled";

			try {
				const accessToken = await token();

				// Google wants the bytes, not a URL, so the file passes through
				// here. A resumable upload keeps that from being one huge request.
				const media = await fetch(url);
				if (!media.ok) {
					return fail({
						code: "invalid_request",
						message: `Could not fetch ${url}: ${media.status}`,
						platform: "youtube",
					});
				}
				const bytes = new Uint8Array(await media.arrayBuffer());

				const metadata = {
					snippet: {
						title,
						description: (extra.description as string) ?? request.caption,
						categoryId: (extra.categoryId as string) ?? "22",
						tags: extra.tags,
					},
					status: {
						privacyStatus: (extra.privacyStatus as string) ?? "private",
						madeForKids: extra.madeForKids ?? false,
						selfDeclaredMadeForKids: extra.madeForKids ?? false,
					},
				};

				const init = await fetch(
					`${upload}/videos?uploadType=resumable&part=snippet,status`,
					{
						method: "POST",
						headers: {
							Authorization: `Bearer ${accessToken}`,
							"Content-Type": "application/json",
							"X-Upload-Content-Length": String(bytes.byteLength),
							"X-Upload-Content-Type":
								media.headers.get("content-type") ?? "video/*",
						},
						body: JSON.stringify(metadata),
					},
				);
				if (!init.ok) {
					const text = await init.text();
					throw fromResponse(init.status, safeJson(text), text);
				}

				const session = init.headers.get("location");
				if (!session) {
					throw new Error("YouTube started an upload without a session URL.");
				}

				const uploaded = await fetch(session, {
					method: "PUT",
					headers: {
						Authorization: `Bearer ${accessToken}`,
						"Content-Length": String(bytes.byteLength),
					},
					body: bytes,
				});
				const text = await uploaded.text();
				const body = safeJson(text) as { id?: string };
				if (!uploaded.ok) throw fromResponse(uploaded.status, body, text);
				if (!body.id) throw new Error("YouTube uploaded but returned no id.");

				return ok({
					platform: "youtube",
					id: body.id,
					url: `https://www.youtube.com/watch?v=${body.id}`,
				});
			} catch (error) {
				const flags = error as { authError?: boolean; rateLimited?: boolean };
				if (flags?.authError) {
					return failFrom("auth_error", error, { platform: "youtube" });
				}
				if (flags?.rateLimited) {
					return failFrom("rate_limited", error, { platform: "youtube" });
				}
				return failFrom("platform_error", error, { platform: "youtube" });
			}
		},

		async accounts() {
			try {
				const accessToken = await token();
				const response = await fetch(`${api}/channels?part=snippet&mine=true`, {
					headers: { Authorization: `Bearer ${accessToken}` },
				});
				const text = await response.text();
				const body = safeJson(text) as {
					items?: Array<{
						id?: string;
						snippet?: { title?: string; customUrl?: string };
					}>;
				};
				if (!response.ok) throw fromResponse(response.status, body, text);

				return ok(
					(body.items ?? [])
						.filter((item) => item.id)
						.map((item) => ({
							platform: "youtube" as const,
							id: item.id as string,
							displayName: item.snippet?.title,
							username: item.snippet?.customUrl,
						})),
				);
			} catch (error) {
				return failFrom("platform_error", error, { platform: "youtube" });
			}
		},

		oauth(): OAuthFlow | undefined {
			if (!options.clientId || !options.clientSecret) return undefined;
			const clientId = options.clientId;
			const clientSecret = options.clientSecret;

			async function exchangeAt(
				params: Record<string, string>,
			): Promise<Result<OAuthToken>> {
				try {
					const response = await fetch(TOKEN_URL, {
						method: "POST",
						headers: { "Content-Type": "application/x-www-form-urlencoded" },
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
							message:
								body.error_description || text || `Google ${response.status}`,
							platform: "youtube",
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
					return failFrom("auth_error", error, { platform: "youtube" });
				}
			}

			return {
				authUrl({ state, redirectUri }) {
					const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
					url.searchParams.set("client_id", clientId);
					url.searchParams.set(
						"redirect_uri",
						redirectUri ?? options.redirectUri ?? "",
					);
					url.searchParams.set("response_type", "code");
					url.searchParams.set(
						"scope",
						"https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly",
					);
					// Without both, Google hands back a refresh token once and never
					// again — and the second time you integrate, it is missing.
					url.searchParams.set("access_type", "offline");
					url.searchParams.set("prompt", "consent");
					url.searchParams.set("state", state);
					return url.toString();
				},

				exchange({ code, redirectUri }) {
					return exchangeAt({
						grant_type: "authorization_code",
						code,
						client_id: clientId,
						client_secret: clientSecret,
						redirect_uri: redirectUri ?? options.redirectUri ?? "",
					});
				},

				refresh({ token: refreshToken }) {
					return exchangeAt({
						grant_type: "refresh_token",
						refresh_token: refreshToken,
						client_id: clientId,
						client_secret: clientSecret,
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
