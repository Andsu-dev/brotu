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

const API = "https://api.linkedin.com/v2";
const RESTLI_VERSION = "2.0.0";

export interface LinkedInOptions {
	accessToken?: string;
	/**
	 * The member id — LinkedIn's OIDC `sub`. Posts are authored by
	 * `urn:li:person:<id>`. Pass `organizationId` instead to post as a company.
	 */
	memberId?: string;
	/** Post as a company page: `urn:li:organization:<id>`. */
	organizationId?: string;
	clientId?: string;
	clientSecret?: string;
	redirectUri?: string;
	baseUrl?: string;
}

/**
 * LinkedIn. Media is registered, uploaded, then referenced by URN — the post
 * itself never carries bytes.
 */
export function linkedin(options: LinkedInOptions = {}): SocialProvider {
	const api = (options.baseUrl ?? API).replace(/\/$/, "");

	function headers(): Record<string, string> {
		if (!options.accessToken) {
			throw Object.assign(
				new Error("No LinkedIn access token was configured."),
				{ authError: true },
			);
		}
		return {
			Authorization: `Bearer ${options.accessToken}`,
			"Content-Type": "application/json",
			"X-Restli-Protocol-Version": RESTLI_VERSION,
		};
	}

	function author(): string {
		if (options.organizationId) {
			return `urn:li:organization:${options.organizationId}`;
		}
		if (!options.memberId) {
			throw Object.assign(
				new Error(
					"LinkedIn needs an author — pass linkedin({ memberId }) or ({ organizationId }).",
				),
				{ invalid: true },
			);
		}
		return `urn:li:person:${options.memberId}`;
	}

	async function request<T>(
		path: string,
		init: RequestInit,
	): Promise<{ body: T; response: Response }> {
		const response = await fetch(`${api}${path}`, {
			...init,
			headers: { ...headers(), ...(init.headers as Record<string, string>) },
		});
		const text = await response.text();
		const body = safeJson(text);
		if (!response.ok) {
			const message =
				(body as { message?: string })?.message ||
				text ||
				`LinkedIn ${response.status}`;
			throw Object.assign(new Error(message), {
				status: response.status,
				authError: response.status === 401,
				rateLimited: response.status === 429,
				cause: body,
			});
		}
		return { body: body as T, response };
	}

	/** Register, upload the bytes, hand back the asset URN the post refers to. */
	async function uploadAsset(
		url: string,
		type: "image" | "video",
	): Promise<string> {
		const { body: registered } = await request<{
			value?: {
				asset?: string;
				uploadMechanism?: Record<
					string,
					{ uploadUrl?: string; headers?: Record<string, string> }
				>;
			};
		}>("/assets?action=registerUpload", {
			method: "POST",
			body: JSON.stringify({
				registerUploadRequest: {
					recipes: [
						type === "video"
							? "urn:li:digitalmediaRecipe:feedshare-video"
							: "urn:li:digitalmediaRecipe:feedshare-image",
					],
					owner: author(),
					serviceRelationships: [
						{
							relationshipType: "OWNER",
							identifier: "urn:li:userGeneratedContent",
						},
					],
				},
			}),
		});

		const mechanism =
			registered.value?.uploadMechanism?.[
				"com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest"
			];
		const uploadUrl = mechanism?.uploadUrl;
		const asset = registered.value?.asset;
		if (!uploadUrl || !asset) {
			throw new Error("LinkedIn registered an upload without a URL or asset.");
		}

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

		const uploaded = await fetch(uploadUrl, {
			method: "PUT",
			headers: {
				...(mechanism?.headers ?? {}),
				Authorization: `Bearer ${options.accessToken}`,
				"Content-Type":
					media.headers.get("content-type") ??
					(type === "video" ? "video/mp4" : "image/jpeg"),
			},
			body: bytes,
		});
		if (!uploaded.ok) {
			throw new Error(
				`LinkedIn upload failed (${uploaded.status}): ${await uploaded.text()}`,
			);
		}
		return asset;
	}

	return {
		name: "linkedin",
		platforms: ["linkedin"],

		async publish(_platform, request_): Promise<Result<PostResult>> {
			try {
				const extra = (request_.options?.linkedin ?? {}) as Record<
					string,
					unknown
				>;
				const urls = request_.mediaUrls ?? [];
				const articleUrl = extra.articleUrl as string | undefined;

				let shareContent: Record<string, unknown>;

				if (articleUrl) {
					shareContent = {
						shareCommentary: { text: request_.caption },
						shareMediaCategory: "ARTICLE",
						media: [
							{
								status: "READY",
								originalUrl: articleUrl,
								title: {
									text:
										(extra.articleTitle as string) ??
										request_.caption.slice(0, 200) ??
										"Link",
								},
								...(extra.articleDescription
									? {
											description: {
												text: String(extra.articleDescription).slice(0, 256),
											},
										}
									: {}),
							},
						],
					};
				} else if (urls.length === 0) {
					shareContent = {
						shareCommentary: { text: request_.caption },
						shareMediaCategory: "NONE",
					};
				} else {
					const type =
						request_.mediaTypes?.[0] ?? inferMediaType(urls[0] as string);
					const asset = await uploadAsset(urls[0] as string, type);
					shareContent = {
						shareCommentary: { text: request_.caption },
						shareMediaCategory: type === "video" ? "VIDEO" : "IMAGE",
						media: [
							{
								status: "READY",
								media: asset,
								title: { text: request_.caption.slice(0, 200) || "Media" },
							},
						],
					};
				}

				const { body, response } = await request<{ id?: string }>("/ugcPosts", {
					method: "POST",
					body: JSON.stringify({
						author: author(),
						lifecycleState: "PUBLISHED",
						specificContent: { "com.linkedin.ugc.ShareContent": shareContent },
						visibility: {
							"com.linkedin.ugc.MemberNetworkVisibility":
								(extra.visibility as string) ?? "PUBLIC",
						},
					}),
				});

				// LinkedIn puts the id in a header more reliably than in the body.
				const id =
					response.headers.get("x-restli-id") ??
					response.headers.get("X-RestLi-Id") ??
					body.id;
				if (!id) throw new Error("LinkedIn published but returned no id.");

				return ok({
					platform: "linkedin",
					id,
					url: `https://www.linkedin.com/feed/update/${id}`,
				});
			} catch (error) {
				const flags = error as {
					authError?: boolean;
					rateLimited?: boolean;
					invalid?: boolean;
				};
				if (flags?.invalid)
					return failFrom("invalid_request", error, { platform: "linkedin" });
				if (flags?.authError)
					return failFrom("auth_error", error, { platform: "linkedin" });
				if (flags?.rateLimited)
					return failFrom("rate_limited", error, { platform: "linkedin" });
				return failFrom("platform_error", error, { platform: "linkedin" });
			}
		},

		async accounts() {
			try {
				const { body } = await request<{
					sub?: string;
					name?: string;
					email?: string;
				}>("/userinfo", { method: "GET" });
				if (!body.sub) return ok([]);
				return ok([
					{
						platform: "linkedin" as const,
						id: body.sub,
						displayName: body.name,
					},
				]);
			} catch (error) {
				return failFrom("platform_error", error, { platform: "linkedin" });
			}
		},

		oauth(): OAuthFlow | undefined {
			if (!options.clientId || !options.clientSecret) return undefined;
			const clientId = options.clientId;
			const clientSecret = options.clientSecret;

			async function token(
				params: Record<string, string>,
			): Promise<Result<OAuthToken>> {
				try {
					const response = await fetch(
						"https://www.linkedin.com/oauth/v2/accessToken",
						{
							method: "POST",
							headers: { "Content-Type": "application/x-www-form-urlencoded" },
							body: new URLSearchParams(params),
						},
					);
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
								body.error_description || text || `LinkedIn ${response.status}`,
							platform: "linkedin",
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
					return failFrom("auth_error", error, { platform: "linkedin" });
				}
			}

			return {
				authUrl({ state, redirectUri }) {
					const url = new URL(
						"https://www.linkedin.com/oauth/v2/authorization",
					);
					url.searchParams.set("response_type", "code");
					url.searchParams.set("client_id", clientId);
					url.searchParams.set(
						"redirect_uri",
						redirectUri ?? options.redirectUri ?? "",
					);
					// openid/profile give you the `sub` that becomes the author URN.
					url.searchParams.set("scope", "openid profile w_member_social");
					url.searchParams.set("state", state);
					return url.toString();
				},

				exchange({ code, redirectUri }) {
					return token({
						grant_type: "authorization_code",
						code,
						client_id: clientId,
						client_secret: clientSecret,
						redirect_uri: redirectUri ?? options.redirectUri ?? "",
					});
				},

				/** Only apps approved for it get a refresh token from LinkedIn. */
				refresh({ token: refreshToken }) {
					return token({
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
