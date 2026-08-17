import { afterEach, describe, expect, it, mock } from "bun:test";
import { brotu } from "../client";
import { linkedin } from "../providers/linkedin";
import { tiktok } from "../providers/tiktok";
import { x } from "../providers/x";

interface Call {
	url: string;
	method: string;
	body?: unknown;
	headers?: Record<string, string>;
}

/**
 * Answers each call with the next queued reply. A reply is either a body, or
 * `{ __body, __headers, __status }` when the test cares about the envelope.
 */
function api(...replies: unknown[]) {
	const queue = [...replies];
	const calls: Call[] = [];
	globalThis.fetch = mock((input: string | URL, init?: RequestInit) => {
		calls.push({
			url: String(input),
			method: init?.method ?? "GET",
			body: init?.body,
			headers: init?.headers as Record<string, string>,
		});
		const next = (queue.shift() ?? {}) as Record<string, unknown>;
		const envelope = next?.__body !== undefined;
		return Promise.resolve(
			new Response(
				envelope ? JSON.stringify(next.__body) : JSON.stringify(next),
				{
					status: envelope ? ((next.__status as number) ?? 200) : 200,
					headers: {
						"content-type": "application/json",
						...((next.__headers as Record<string, string>) ?? {}),
					},
				},
			),
		);
	}) as unknown as typeof fetch;
	return calls;
}

/** A fetch that serves media bytes for one URL and JSON for everything else. */
function withMedia(mediaUrl: string, ...replies: unknown[]) {
	const calls = api(...replies);
	const inner = globalThis.fetch;
	globalThis.fetch = ((input: string | URL, init?: RequestInit) => {
		if (String(input) === mediaUrl) {
			return Promise.resolve(
				new Response(new Uint8Array([1, 2, 3, 4]), {
					headers: { "content-type": "video/mp4" },
				}),
			);
		}
		return inner(input as string, init);
	}) as typeof fetch;
	return calls;
}

describe("tiktok", () => {
	afterEach(() => mock.restore());

	it("has no text-only post, and says so", async () => {
		const client = brotu({ providers: [tiktok({ accessToken: "t" })] });

		const { error } = await client.tiktok.post({ caption: "oi" });

		expect(error?.code).toBe("invalid_request");
	});

	it("uploads video bytes after the init handshake", async () => {
		const calls = withMedia(
			"https://x/a.mp4",
			{ data: { publish_id: "pub-1", upload_url: "https://upload.tiktok/1" } },
			{},
		);
		const client = brotu({ providers: [tiktok({ accessToken: "t" })] });

		const { data, error } = await client.tiktok.post({
			caption: "oi",
			mediaUrls: ["https://x/a.mp4"],
		});

		expect(error).toBeNull();
		expect(data?.id).toBe("pub-1");
		// Inbox by default: direct posting needs an audited app.
		expect(calls[0]?.url).toContain("/inbox/video/init/");
		const upload = calls.at(-1);
		expect(upload?.method).toBe("PUT");
		expect(upload?.url).toBe("https://upload.tiktok/1");
	});

	it("pulls photos from URL instead of uploading them", async () => {
		const calls = api({ data: { publish_id: "pub-2" } });
		const client = brotu({ providers: [tiktok({ accessToken: "t" })] });

		const { data } = await client.tiktok.post({
			caption: "carrossel",
			mediaUrls: ["https://x/a.jpg", "https://x/b.jpg"],
		});

		expect(data?.id).toBe("pub-2");
		expect(calls[0]?.url).toContain("/content/init/");
		const body = JSON.parse(String(calls[0]?.body));
		expect(body.source_info.source).toBe("PULL_FROM_URL");
		expect(body.source_info.photo_images).toHaveLength(2);
		// Never public unless asked.
		expect(body.post_info.privacy_level).toBe("SELF_ONLY");
	});

	it("catches an error TikTok reports inside a 200", async () => {
		api({
			__body: {
				error: { code: "spam_risk_too_many_posts", message: "slow down" },
			},
		});
		const client = brotu({ providers: [tiktok({ accessToken: "t" })] });

		const { error } = await client.tiktok.post({
			caption: "oi",
			mediaUrls: ["https://x/a.jpg"],
		});

		expect(error?.code).toBe("platform_error");
		expect(error?.message).toBe("slow down");
	});

	it("uses client_key, which is what TikTok calls it", () => {
		const client = brotu({
			providers: [tiktok({ clientKey: "ck", clientSecret: "cs" })],
		});

		const url = new URL(client.tiktok.oauth?.authUrl({ state: "s" }) as string);

		expect(url.searchParams.get("client_key")).toBe("ck");
		expect(url.searchParams.get("client_id")).toBeNull();
	});
});

describe("linkedin", () => {
	afterEach(() => mock.restore());

	it("posts text with no media category", async () => {
		const calls = api({
			__body: {},
			__headers: { "x-restli-id": "urn:li:share:1" },
		});
		const client = brotu({
			providers: [linkedin({ accessToken: "t", memberId: "m1" })],
		});

		const { data } = await client.linkedin.post({ caption: "oi" });

		expect(data?.id).toBe("urn:li:share:1");
		const body = JSON.parse(String(calls[0]?.body));
		expect(body.author).toBe("urn:li:person:m1");
		expect(
			body.specificContent["com.linkedin.ugc.ShareContent"].shareMediaCategory,
		).toBe("NONE");
	});

	it("registers, uploads, then references the asset", async () => {
		const calls = withMedia(
			"https://x/a.mp4",
			{
				value: {
					asset: "urn:li:digitalmediaAsset:1",
					uploadMechanism: {
						"com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest": {
							uploadUrl: "https://upload.linkedin/1",
						},
					},
				},
			},
			{},
			{ __body: {}, __headers: { "x-restli-id": "urn:li:share:2" } },
		);
		const client = brotu({
			providers: [linkedin({ accessToken: "t", memberId: "m1" })],
		});

		const { data, error } = await client.linkedin.post({
			caption: "com vídeo",
			mediaUrls: ["https://x/a.mp4"],
		});

		expect(error).toBeNull();
		expect(data?.id).toBe("urn:li:share:2");
		expect(calls[0]?.url).toContain("registerUpload");
		expect(
			calls.find((c) => c.url === "https://upload.linkedin/1")?.method,
		).toBe("PUT");
		const post = JSON.parse(String(calls.at(-1)?.body));
		expect(
			post.specificContent["com.linkedin.ugc.ShareContent"].media[0].media,
		).toBe("urn:li:digitalmediaAsset:1");
	});

	it("authors as the organization when one is given", async () => {
		const calls = api({
			__body: {},
			__headers: { "x-restli-id": "urn:li:share:3" },
		});
		const client = brotu({
			providers: [linkedin({ accessToken: "t", organizationId: "o1" })],
		});

		await client.linkedin.post({ caption: "oi" });

		expect(JSON.parse(String(calls[0]?.body)).author).toBe(
			"urn:li:organization:o1",
		);
	});

	it("refuses to guess an author", async () => {
		const client = brotu({ providers: [linkedin({ accessToken: "t" })] });

		const { error } = await client.linkedin.post({ caption: "oi" });

		expect(error?.code).toBe("invalid_request");
		expect(error?.message).toContain("memberId");
	});
});

describe("x", () => {
	afterEach(() => mock.restore());

	it("posts text in one call", async () => {
		const calls = api({ data: { id: "1" } });
		const client = brotu({ providers: [x({ accessToken: "t" })] });

		const { data } = await client.x.post({ caption: "oi" });

		expect(data?.url).toBe("https://x.com/i/status/1");
		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toContain("/2/tweets");
	});

	it("runs init, append and finalize before posting media", async () => {
		const calls = withMedia(
			"https://x/a.mp4",
			{ data: { id: "media-1" } },
			{},
			{ data: {} },
			{ data: { id: "tweet-1" } },
		);
		const client = brotu({ providers: [x({ accessToken: "t" })] });

		const { data, error } = await client.x.post({
			caption: "com vídeo",
			mediaUrls: ["https://x/a.mp4"],
		});

		expect(error).toBeNull();
		expect(data?.id).toBe("tweet-1");
		expect(
			calls.filter((c) => c.url.includes("/media/upload")).map((c) => c.url),
		).toEqual([
			"https://api.x.com/2/media/upload",
			"https://api.x.com/2/media/upload/media-1/append",
			"https://api.x.com/2/media/upload/media-1/finalize",
		]);
		expect(JSON.parse(String(calls.at(-1)?.body)).media.media_ids).toEqual([
			"media-1",
		]);
	});

	it("carries retry-after through as retryAfterSeconds", async () => {
		api({
			__body: { detail: "Too Many Requests" },
			__status: 429,
			__headers: { "retry-after": "42" },
		});
		const client = brotu({ providers: [x({ accessToken: "t" })] });

		const { error } = await client.x.post({ caption: "oi" });

		expect(error?.code).toBe("rate_limited");
		expect(error?.retryAfterSeconds).toBe(42);
	});

	it("asks for offline.access, or there is no refresh token", () => {
		const client = brotu({ providers: [x({ clientId: "id" })] });

		const url = new URL(client.x.oauth?.authUrl({ state: "s" }) as string);

		expect(url.searchParams.get("scope")).toContain("offline.access");
		// X rejects an authorize call without PKCE.
		expect(url.searchParams.get("code_challenge_method")).toBe("plain");
	});
});

describe("all seven platforms", () => {
	it("are reachable once every plugin is registered", () => {
		const client = brotu({
			providers: [
				tiktok({ accessToken: "t" }),
				linkedin({ accessToken: "t", memberId: "m" }),
				x({ accessToken: "t" }),
			],
		});

		expect(client.platforms().sort()).toEqual(["linkedin", "tiktok", "x"]);
	});
});
