import { createHmac, timingSafeEqual } from "node:crypto";
import {
	fail,
	failFrom,
	inferMediaType,
	type OAuthFlow,
	type OAuthToken,
	ok,
	type Platform,
	type PostRequest,
	type PostResult,
	type Result,
	type SocialProvider,
	type WebhookEvent,
	type WebhookVerifier,
} from "../types";

const GRAPH = "https://graph.facebook.com/v21.0";
const THREADS_GRAPH = "https://graph.threads.net/v1.0";

/** Platforms one Meta app reaches. */
const META_PLATFORMS = ["facebook", "instagram", "threads"] as const;

export interface MetaOptions {
	/**
	 * A user or page access token. Without it the plugin still registers the
	 * namespaces, so `oauth` works and you can get one.
	 */
	accessToken?: string;
	/** The Page to publish to. Required for Facebook. */
	pageId?: string;
	/** The IG business account id. Required for Instagram. */
	instagramAccountId?: string;
	/** The Threads user id. Required for Threads. */
	threadsUserId?: string;
	/** App credentials. Needed for the OAuth dance and to verify webhooks. */
	appId?: string;
	appSecret?: string;
	/** Where Meta sends the user back. Can also be passed per call. */
	redirectUri?: string;
	/** The token you set on the webhook subscription, echoed on the challenge. */
	webhookVerifyToken?: string;
	/** How long to wait for an Instagram or Threads container to finish. */
	publishTimeoutMs?: number;
	/** Override for tests. */
	baseUrl?: string;
}

interface GraphError {
	error?: { message?: string; type?: string; code?: number };
}

/**
 * Facebook, Instagram and Threads — one plugin, because one Meta app and one
 * token reach all three. Splitting them would mean asking for the same
 * credential three times.
 */
export function meta(options: MetaOptions = {}): SocialProvider {
	const graph = (options.baseUrl ?? GRAPH).replace(/\/$/, "");
	const threadsGraph = options.baseUrl ? graph : THREADS_GRAPH;
	const timeoutMs = options.publishTimeoutMs ?? 120_000;

	async function call<T>(
		origin: string,
		path: string,
		init: { method: "GET" | "POST"; params?: Record<string, unknown> },
	): Promise<T> {
		const token = options.accessToken;
		if (!token) {
			throw Object.assign(new Error("No Meta access token was configured."), {
				authError: true,
			});
		}

		const url = new URL(`${origin}${path}`);
		const body = new URLSearchParams({ access_token: token });
		for (const [key, value] of Object.entries(init.params ?? {})) {
			if (value === undefined || value === null) continue;
			const encoded = typeof value === "string" ? value : JSON.stringify(value);
			if (init.method === "GET") url.searchParams.set(key, encoded);
			else body.set(key, encoded);
		}
		if (init.method === "GET") url.searchParams.set("access_token", token);

		const response = await fetch(url, {
			method: init.method,
			...(init.method === "POST"
				? {
						body,
						headers: {
							"Content-Type": "application/x-www-form-urlencoded",
						},
					}
				: {}),
		});

		const text = await response.text();
		let parsed: unknown;
		try {
			parsed = text ? JSON.parse(text) : {};
		} catch {
			parsed = text;
		}

		if (!response.ok) {
			const graphError = (parsed as GraphError)?.error;
			throw Object.assign(
				new Error(graphError?.message || text || `Meta ${response.status}`),
				{
					status: response.status,
					authError: response.status === 401 || graphError?.code === 190,
					rateLimited: response.status === 429 || graphError?.code === 4,
					cause: parsed,
				},
			);
		}
		return parsed as T;
	}

	/**
	 * Instagram and Threads both publish in two steps: create a container, then
	 * publish it once the platform finishes fetching your media. The wait is
	 * theirs, not ours — a video container is not ready the moment it is made.
	 */
	async function waitForContainer(
		origin: string,
		containerId: string,
	): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			const status = await call<{ status_code?: string; status?: string }>(
				origin,
				`/${containerId}`,
				{ method: "GET", params: { fields: "status_code,status" } },
			);
			const code = status.status_code ?? status.status ?? "";
			if (code === "FINISHED" || code === "PUBLISHED") return;
			if (code === "ERROR" || code === "EXPIRED") {
				throw new Error(`Meta container ${containerId} failed: ${code}`);
			}
			if (Date.now() >= deadline) {
				throw Object.assign(
					new Error(
						`Container ${containerId} was still ${code || "pending"} after ${Math.round(timeoutMs / 1000)}s.`,
					),
					{ timedOut: true },
				);
			}
			await new Promise((resolve) => setTimeout(resolve, 3000));
		}
	}

	async function publishFacebook(
		request: PostRequest,
	): Promise<Result<PostResult>> {
		const pageId = options.pageId;
		if (!pageId) {
			return fail({
				code: "invalid_request",
				message: "Facebook needs a pageId — pass it to meta({ pageId }).",
				platform: "facebook",
			});
		}

		const extra = request.options?.facebook ?? {};
		const [first] = request.mediaUrls ?? [];
		const type = first
			? (request.mediaTypes?.[0] ?? inferMediaType(first))
			: undefined;

		// Three different endpoints, because a Page post, a photo and a video are
		// three different objects to Facebook.
		const { path, params } = !first
			? { path: `/${pageId}/feed`, params: { message: request.caption } }
			: type === "video"
				? {
						path: `/${pageId}/videos`,
						params: { file_url: first, description: request.caption },
					}
				: {
						path: `/${pageId}/photos`,
						params: { url: first, caption: request.caption },
					};

		const created = await call<{ id?: string; post_id?: string }>(graph, path, {
			method: "POST",
			params: { ...params, ...extra },
		});
		const id = created.post_id ?? created.id;
		if (!id) throw new Error("Facebook accepted the post but returned no id.");
		return ok({
			platform: "facebook",
			id,
			url: `https://www.facebook.com/${id}`,
		});
	}

	async function publishInstagram(
		request: PostRequest,
	): Promise<Result<PostResult>> {
		const igId = options.instagramAccountId;
		if (!igId) {
			return fail({
				code: "invalid_request",
				message:
					"Instagram needs an account id — pass meta({ instagramAccountId }).",
				platform: "instagram",
			});
		}
		const urls = request.mediaUrls ?? [];
		if (urls.length === 0) {
			return fail({
				code: "invalid_request",
				message: "Instagram has no text-only post: pass at least one mediaUrl.",
				platform: "instagram",
			});
		}

		const extra = request.options?.instagram ?? {};
		let containerId: string;

		if (urls.length === 1) {
			const url = urls[0] as string;
			const type = request.mediaTypes?.[0] ?? inferMediaType(url);
			const created = await call<{ id?: string }>(graph, `/${igId}/media`, {
				method: "POST",
				params: {
					caption: request.caption,
					...(type === "video"
						? { video_url: url, media_type: "REELS" }
						: { image_url: url }),
					...extra,
				},
			});
			if (!created.id) throw new Error("Instagram returned no container id.");
			containerId = created.id;
		} else {
			// A carousel is containers all the way down: one per item, then one
			// more that holds them.
			const children = await Promise.all(
				urls.map(async (url, index) => {
					const type = request.mediaTypes?.[index] ?? inferMediaType(url);
					const child = await call<{ id?: string }>(graph, `/${igId}/media`, {
						method: "POST",
						params: {
							is_carousel_item: "true",
							...(type === "video" ? { video_url: url } : { image_url: url }),
						},
					});
					if (!child.id) throw new Error("Instagram returned no child id.");
					return child.id;
				}),
			);
			const created = await call<{ id?: string }>(graph, `/${igId}/media`, {
				method: "POST",
				params: {
					media_type: "CAROUSEL",
					children: children.join(","),
					caption: request.caption,
					...extra,
				},
			});
			if (!created.id) throw new Error("Instagram returned no container id.");
			containerId = created.id;
		}

		await waitForContainer(graph, containerId);
		const published = await call<{ id?: string }>(
			graph,
			`/${igId}/media_publish`,
			{ method: "POST", params: { creation_id: containerId } },
		);
		if (!published.id)
			throw new Error("Instagram published but returned no id.");
		return ok({ platform: "instagram", id: published.id });
	}

	async function publishThreads(
		request: PostRequest,
	): Promise<Result<PostResult>> {
		const userId = options.threadsUserId;
		if (!userId) {
			return fail({
				code: "invalid_request",
				message: "Threads needs a user id — pass meta({ threadsUserId }).",
				platform: "threads",
			});
		}

		const [url] = request.mediaUrls ?? [];
		const type = url
			? (request.mediaTypes?.[0] ?? inferMediaType(url))
			: undefined;
		const created = await call<{ id?: string }>(
			threadsGraph,
			`/${userId}/threads`,
			{
				method: "POST",
				params: {
					text: request.caption,
					media_type: !url ? "TEXT" : type === "video" ? "VIDEO" : "IMAGE",
					...(url && type === "video" ? { video_url: url } : {}),
					...(url && type !== "video" ? { image_url: url } : {}),
					...(request.options?.threads ?? {}),
				},
			},
		);
		if (!created.id) throw new Error("Threads returned no container id.");

		// Text-only threads are ready at once; media needs the same wait as IG.
		if (url) await waitForContainer(threadsGraph, created.id);

		const published = await call<{ id?: string }>(
			threadsGraph,
			`/${userId}/threads_publish`,
			{ method: "POST", params: { creation_id: created.id } },
		);
		if (!published.id) throw new Error("Threads published but returned no id.");
		return ok({ platform: "threads", id: published.id });
	}

	function toResult(error: unknown, platform: Platform): Result<never> {
		const meta = error as {
			authError?: boolean;
			rateLimited?: boolean;
			timedOut?: boolean;
		};
		if (meta?.authError) return failFrom("auth_error", error, { platform });
		if (meta?.rateLimited) return failFrom("rate_limited", error, { platform });
		if (meta?.timedOut) return failFrom("timeout", error, { platform });
		return failFrom("platform_error", error, { platform });
	}

	return {
		name: "meta",
		platforms: META_PLATFORMS,

		async publish(platform, request) {
			try {
				if (platform === "facebook") return await publishFacebook(request);
				if (platform === "instagram") return await publishInstagram(request);
				if (platform === "threads") return await publishThreads(request);
				return fail({
					code: "unsupported",
					message: `The meta plugin does not serve ${platform}.`,
					platform,
				});
			} catch (error) {
				return toResult(error, platform);
			}
		},

		async accounts(platform) {
			try {
				if (platform === "facebook") {
					const payload = await call<{
						data?: Array<{ id: string; name?: string }>;
					}>(graph, "/me/accounts", {
						method: "GET",
						params: { fields: "id,name" },
					});
					return ok(
						(payload.data ?? []).map((page) => ({
							platform: "facebook" as const,
							id: page.id,
							displayName: page.name,
						})),
					);
				}
				const id =
					platform === "instagram"
						? options.instagramAccountId
						: options.threadsUserId;
				if (!id) return ok([]);
				const origin = platform === "threads" ? threadsGraph : graph;
				const profile = await call<{ id: string; username?: string }>(
					origin,
					`/${id}`,
					{ method: "GET", params: { fields: "id,username" } },
				);
				return ok([{ platform, id: profile.id, username: profile.username }]);
			} catch (error) {
				return toResult(error, platform);
			}
		},

		oauth(platform) {
			return metaOAuth(platform, options, threadsGraph, graph);
		},

		webhooks: metaWebhooks(options),
	};
}

/** The scopes each platform's publishing actually needs, nothing spare. */
const SCOPES: Record<string, string[]> = {
	facebook: ["pages_show_list", "pages_manage_posts", "pages_read_engagement"],
	instagram: [
		"instagram_basic",
		"instagram_content_publish",
		"pages_show_list",
	],
	threads: ["threads_basic", "threads_content_publish"],
};

function metaOAuth(
	platform: Platform,
	options: MetaOptions,
	threadsGraph: string,
	graph: string,
): OAuthFlow | undefined {
	if (!options.appId || !options.appSecret) return undefined;
	const isThreads = platform === "threads";
	const appId = options.appId;
	const appSecret = options.appSecret;

	async function token(url: URL): Promise<Result<OAuthToken>> {
		try {
			const response = await fetch(url);
			const text = await response.text();
			const body = (text ? JSON.parse(text) : {}) as {
				access_token?: string;
				expires_in?: number;
				refresh_token?: string;
				error?: { message?: string };
			};
			if (!response.ok || !body.access_token) {
				return fail({
					code: "auth_error",
					message: body.error?.message || text || `Meta ${response.status}`,
					platform,
					cause: body,
				});
			}
			return ok({
				accessToken: body.access_token,
				expiresIn: body.expires_in,
				refreshToken: body.refresh_token,
			});
		} catch (error) {
			return failFrom("auth_error", error, { platform });
		}
	}

	return {
		authUrl({ state, redirectUri }) {
			const base = isThreads
				? "https://threads.net/oauth/authorize"
				: "https://www.facebook.com/v21.0/dialog/oauth";
			const url = new URL(base);
			url.searchParams.set("client_id", appId);
			url.searchParams.set(
				"redirect_uri",
				redirectUri ?? options.redirectUri ?? "",
			);
			url.searchParams.set("scope", (SCOPES[platform] ?? []).join(","));
			url.searchParams.set("response_type", "code");
			url.searchParams.set("state", state);
			return url.toString();
		},

		exchange({ code, redirectUri }) {
			const origin = isThreads ? threadsGraph : graph;
			const url = new URL(`${origin}/oauth/access_token`);
			url.searchParams.set("client_id", appId);
			url.searchParams.set("client_secret", appSecret);
			url.searchParams.set("code", code);
			url.searchParams.set(
				"redirect_uri",
				redirectUri ?? options.redirectUri ?? "",
			);
			return token(url);
		},

		/**
		 * Meta has no refresh token: you trade a short-lived token for a
		 * long-lived one, and later trade that for another. Same call, so
		 * `refresh` is the honest name for it here.
		 */
		refresh({ token: current }) {
			const origin = isThreads ? threadsGraph : graph;
			const url = new URL(`${origin}/oauth/access_token`);
			if (isThreads) {
				url.searchParams.set("grant_type", "th_exchange_token");
				url.searchParams.set("client_secret", appSecret);
				url.searchParams.set("access_token", current);
			} else {
				url.searchParams.set("grant_type", "fb_exchange_token");
				url.searchParams.set("client_id", appId);
				url.searchParams.set("client_secret", appSecret);
				url.searchParams.set("fb_exchange_token", current);
			}
			return token(url);
		},
	};
}

function metaWebhooks(options: MetaOptions): WebhookVerifier {
	return {
		/**
		 * Meta verifies a subscription by GETting your endpoint with a token and
		 * a challenge. Echo the challenge only when the token is the one you set.
		 */
		challenge(query) {
			if (query["hub.mode"] !== "subscribe") return undefined;
			if (!options.webhookVerifyToken) return undefined;
			return query["hub.verify_token"] === options.webhookVerifyToken
				? query["hub.challenge"]
				: undefined;
		},

		verify({ rawBody, headers }) {
			if (!options.appSecret) {
				return fail({
					code: "auth_error",
					message:
						"Pass meta({ appSecret }) — a signature cannot be checked without it.",
				});
			}
			const header =
				headers["x-hub-signature-256"] ?? headers["X-Hub-Signature-256"];
			if (!header?.startsWith("sha256=")) {
				return fail({
					code: "auth_error",
					message: "Missing or malformed x-hub-signature-256 header.",
				});
			}

			const expected = createHmac("sha256", options.appSecret)
				.update(rawBody, "utf8")
				.digest();
			const received = Buffer.from(header.slice(7), "hex");
			// Lengths must match before comparing, and the compare stays constant
			// time: a fast reject on the first wrong byte leaks the signature.
			const valid =
				received.length === expected.length &&
				timingSafeEqual(received, expected);

			return valid
				? ok(true as const)
				: fail({
						code: "auth_error",
						message: "Webhook signature did not match.",
					});
		},

		parse(rawBody) {
			try {
				const body = JSON.parse(rawBody) as {
					object?: string;
					entry?: Array<{
						id?: string;
						changes?: Array<{ field?: string; value?: unknown }>;
					}>;
				};
				const platform: Platform =
					body.object === "instagram"
						? "instagram"
						: body.object === "threads"
							? "threads"
							: "facebook";

				const events: WebhookEvent[] = [];
				const receivedAt = new Date().toISOString();
				for (const entry of body.entry ?? []) {
					for (const change of entry.changes ?? []) {
						events.push({
							platform,
							// Meta names the field, not the event: `comments` means a
							// comment happened. Normalise so a caller can switch on it.
							type: `${change.field ?? "unknown"}.changed`,
							objectId: entry.id,
							receivedAt,
							raw: change,
						});
					}
				}
				return ok(events);
			} catch (error) {
				return failFrom("invalid_request", error);
			}
		},
	};
}
