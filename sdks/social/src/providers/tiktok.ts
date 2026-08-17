import {
	fail,
	failFrom,
	inferMediaType,
	type OAuthFlow,
	type OAuthToken,
	ok,
	type PostRequest,
	type PostResult,
	type Result,
	type SocialProvider,
} from "../types";

const API = "https://open.tiktokapis.com";

export interface TikTokOptions {
	accessToken?: string;
	refreshToken?: string;
	/** From the TikTok developer portal. Needed for OAuth. */
	clientKey?: string;
	clientSecret?: string;
	redirectUri?: string;
	/**
	 * Publish straight to the profile instead of dropping a draft in the user's
	 * TikTok inbox. Off by default: direct posting needs an audited app, and an
	 * unaudited one fails at publish time rather than at init.
	 */
	directPost?: boolean;
	baseUrl?: string;
}

interface TikTokEnvelope<T> {
	data?: T;
	error?: { code?: string; message?: string };
}

/**
 * TikTok. Video goes up as bytes; a photo carousel is pulled from your URLs,
 * because TikTok accepts `PULL_FROM_URL` for photos and not for video.
 */
export function tiktok(options: TikTokOptions = {}): SocialProvider {
	const api = (options.baseUrl ?? API).replace(/\/$/, "");

	async function call<T>(path: string, body: unknown): Promise<T> {
		if (!options.accessToken) {
			throw Object.assign(new Error("No TikTok access token was configured."), {
				authError: true,
			});
		}
		const response = await fetch(`${api}${path}`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${options.accessToken}`,
				"Content-Type": "application/json; charset=UTF-8",
			},
			body: JSON.stringify(body),
		});
		const text = await response.text();
		const parsed = safeJson(text) as TikTokEnvelope<T>;

		// TikTok answers 200 with an error envelope, so the status alone is not
		// enough to know it worked.
		const code = parsed?.error?.code;
		const failed = !response.ok || (code && code !== "ok");
		if (failed) {
			throw Object.assign(
				new Error(
					parsed?.error?.message || text || `TikTok ${response.status}`,
				),
				{
					status: response.status,
					authError: response.status === 401 || code === "access_token_invalid",
					rateLimited:
						response.status === 429 || code === "rate_limit_exceeded",
					cause: parsed,
				},
			);
		}
		return parsed.data as T;
	}

	/** The bits TikTok calls `post_info`, shared by video and photo. */
	function postInfo(request: PostRequest, isPhoto: boolean) {
		const extra = (request.options?.tiktok ?? {}) as Record<string, unknown>;
		return {
			title: request.caption.slice(0, 150),
			// SELF_ONLY unless asked: posting publicly on someone's behalf should
			// never be the default.
			privacy_level: extra.privacyLevel ?? "SELF_ONLY",
			disable_comment: extra.disableComment ?? false,
			...(isPhoto
				? {}
				: {
						disable_duet: extra.disableDuet ?? false,
						disable_stitch: extra.disableStitch ?? false,
					}),
			...(extra.autoAddMusic === undefined
				? {}
				: { auto_add_music: extra.autoAddMusic }),
			...(extra.brandContentToggle === undefined
				? {}
				: { brand_content_toggle: extra.brandContentToggle }),
			...(extra.brandOrganicToggle === undefined
				? {}
				: { brand_organic_toggle: extra.brandOrganicToggle }),
		};
	}

	async function publishVideo(
		request: PostRequest,
	): Promise<Result<PostResult>> {
		const url = request.mediaUrls?.[0] as string;
		const media = await fetch(url);
		if (!media.ok) {
			return fail({
				code: "invalid_request",
				message: `Could not fetch ${url}: ${media.status}`,
				platform: "tiktok",
			});
		}
		const bytes = new Uint8Array(await media.arrayBuffer());

		const init = await call<{ publish_id?: string; upload_url?: string }>(
			options.directPost
				? "/v2/post/publish/video/init/"
				: "/v2/post/publish/inbox/video/init/",
			{
				post_info: postInfo(request, false),
				source_info: {
					source: "FILE_UPLOAD",
					video_size: bytes.byteLength,
					// One chunk: TikTok allows it up to 64MB, and chunking a file we
					// already hold in memory buys nothing.
					chunk_size: bytes.byteLength,
					total_chunk_count: 1,
				},
			},
		);
		if (!init.upload_url || !init.publish_id) {
			throw new Error("TikTok started an upload without a URL or publish id.");
		}

		const uploaded = await fetch(init.upload_url, {
			method: "PUT",
			headers: {
				"Content-Type": "video/mp4",
				"Content-Range": `bytes 0-${bytes.byteLength - 1}/${bytes.byteLength}`,
				"Content-Length": String(bytes.byteLength),
			},
			body: bytes,
		});
		if (!uploaded.ok) {
			throw new Error(
				`TikTok upload failed (${uploaded.status}): ${await uploaded.text()}`,
			);
		}

		return ok({ platform: "tiktok", id: init.publish_id });
	}

	async function publishPhotos(
		request: PostRequest,
	): Promise<Result<PostResult>> {
		const init = await call<{ publish_id?: string }>(
			"/v2/post/publish/content/init/",
			{
				post_info: postInfo(request, true),
				source_info: {
					source: "PULL_FROM_URL",
					photo_cover_index: 0,
					photo_images: request.mediaUrls,
				},
				post_mode: options.directPost ? "DIRECT_POST" : "MEDIA_UPLOAD",
				media_type: "PHOTO",
			},
		);
		if (!init.publish_id) {
			throw new Error("TikTok accepted the photos but returned no publish id.");
		}
		return ok({ platform: "tiktok", id: init.publish_id });
	}

	return {
		name: "tiktok",
		platforms: ["tiktok"],

		async publish(_platform, request) {
			const urls = request.mediaUrls ?? [];
			if (urls.length === 0) {
				return fail({
					code: "invalid_request",
					message: "TikTok has no text-only post: pass at least one mediaUrl.",
					platform: "tiktok",
				});
			}

			try {
				const type =
					request.mediaTypes?.[0] ?? inferMediaType(urls[0] as string);
				return type === "video"
					? await publishVideo(request)
					: await publishPhotos(request);
			} catch (error) {
				const flags = error as { authError?: boolean; rateLimited?: boolean };
				if (flags?.authError)
					return failFrom("auth_error", error, { platform: "tiktok" });
				if (flags?.rateLimited)
					return failFrom("rate_limited", error, { platform: "tiktok" });
				return failFrom("platform_error", error, { platform: "tiktok" });
			}
		},

		async accounts() {
			try {
				const profile = await call<{
					user?: { open_id?: string; display_name?: string; username?: string };
				}>("/v2/user/info/", {
					fields: ["open_id", "display_name", "username"],
				});
				const user = profile?.user;
				if (!user?.open_id) return ok([]);
				return ok([
					{
						platform: "tiktok" as const,
						id: user.open_id,
						username: user.username,
						displayName: user.display_name,
					},
				]);
			} catch (error) {
				return failFrom("platform_error", error, { platform: "tiktok" });
			}
		},

		oauth(): OAuthFlow | undefined {
			if (!options.clientKey || !options.clientSecret) return undefined;
			const clientKey = options.clientKey;
			const clientSecret = options.clientSecret;

			async function token(
				params: Record<string, string>,
			): Promise<Result<OAuthToken>> {
				try {
					const response = await fetch(`${api}/v2/oauth/token/`, {
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
								body.error_description || text || `TikTok ${response.status}`,
							platform: "tiktok",
							cause: body,
						});
					}
					return ok({
						accessToken: body.access_token,
						expiresIn: body.expires_in,
						refreshToken: body.refresh_token,
						scopes: body.scope?.split(","),
					});
				} catch (error) {
					return failFrom("auth_error", error, { platform: "tiktok" });
				}
			}

			return {
				authUrl({ state, redirectUri }) {
					const url = new URL("https://www.tiktok.com/v2/auth/authorize/");
					// TikTok calls it client_key, not client_id. Everything else in
					// the dance is standard OAuth2.
					url.searchParams.set("client_key", clientKey);
					url.searchParams.set(
						"scope",
						"user.info.basic,video.publish,video.upload",
					);
					url.searchParams.set("response_type", "code");
					url.searchParams.set(
						"redirect_uri",
						redirectUri ?? options.redirectUri ?? "",
					);
					url.searchParams.set("state", state);
					return url.toString();
				},

				exchange({ code, redirectUri }) {
					return token({
						client_key: clientKey,
						client_secret: clientSecret,
						code,
						grant_type: "authorization_code",
						redirect_uri: redirectUri ?? options.redirectUri ?? "",
					});
				},

				refresh({ token: refreshToken }) {
					return token({
						client_key: clientKey,
						client_secret: clientSecret,
						grant_type: "refresh_token",
						refresh_token: refreshToken,
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
