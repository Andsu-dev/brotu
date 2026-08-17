import { afterEach, describe, expect, it, mock } from "bun:test";
import { createHmac } from "node:crypto";
import { brotu } from "../client";
import { meta } from "../providers/meta";
import { youtube } from "../providers/youtube";
import { inferMediaType } from "../types";

/** Answers each call with the next queued body, recording what was asked. */
function graph(...responses: unknown[]) {
	const queue = [...responses];
	const calls: { url: string; method: string; body?: string }[] = [];
	globalThis.fetch = mock((input: string | URL, init?: RequestInit) => {
		calls.push({
			url: String(input),
			method: init?.method ?? "GET",
			body: init?.body ? String(init.body) : undefined,
		});
		const next = queue.shift() ?? {};
		return Promise.resolve(
			new Response(JSON.stringify(next), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);
	}) as unknown as typeof fetch;
	return calls;
}

const token = { accessToken: "tok" };

describe("inferMediaType", () => {
	it("reads the extension, ignoring the query string", () => {
		expect(inferMediaType("https://x/a.mp4?sig=abc")).toBe("video");
		expect(inferMediaType("https://x/a.MOV")).toBe("video");
		expect(inferMediaType("https://x/a.jpg")).toBe("image");
		expect(inferMediaType("https://x/no-extension")).toBe("image");
	});
});

describe("client", () => {
	afterEach(() => mock.restore());

	it("names the plugin to import when a platform is unconfigured", async () => {
		const client = brotu();

		const { error } = await client.instagram.post({ caption: "oi" });

		expect(error?.code).toBe("unconfigured_platform");
		// Instagram comes from meta(), not from an instagram() that does not exist.
		expect(error?.message).toContain("meta({");
	});

	it("registers Meta's three platforms from one plugin", () => {
		const client = brotu({ providers: [meta({ ...token })] });

		expect(client.platforms().sort()).toEqual([
			"facebook",
			"instagram",
			"threads",
		]);
	});

	it("refuses a post that is neither text nor media", async () => {
		const client = brotu({ providers: [meta({ ...token, pageId: "p1" })] });

		const { error } = await client.facebook.post({ caption: "   " });

		expect(error?.code).toBe("invalid_request");
	});

	it("postAll reports each platform separately instead of failing as one", async () => {
		graph({ id: "fb1" });
		const client = brotu({ providers: [meta({ ...token, pageId: "p1" })] });

		const results = await client.postAll({
			providers: ["facebook", "youtube"],
			caption: "oi",
		});

		expect(results[0]?.data?.platform).toBe("facebook");
		// YouTube has no plugin here, so it fails on its own without hiding the
		// Facebook post that worked.
		expect(results[1]?.error?.code).toBe("unconfigured_platform");
	});

	it("routes client.post({ provider }) to the same place", async () => {
		graph({ id: "fb2" });
		const client = brotu({ providers: [meta({ ...token, pageId: "p1" })] });

		const { data } = await client.post({ provider: "facebook", caption: "oi" });

		expect(data?.id).toBe("fb2");
	});
});

describe("meta publish", () => {
	afterEach(() => mock.restore());

	it("posts text to the Page feed and a photo to /photos", async () => {
		const calls = graph({ id: "1" }, { id: "2" });
		const client = brotu({ providers: [meta({ ...token, pageId: "p1" })] });

		await client.facebook.post({ caption: "só texto" });
		await client.facebook.post({
			caption: "com foto",
			mediaUrls: ["https://x/a.jpg"],
		});

		expect(calls[0]?.url).toContain("/p1/feed");
		expect(calls[1]?.url).toContain("/p1/photos");
	});

	it("creates a container, waits for it, then publishes on Instagram", async () => {
		const calls = graph(
			{ id: "container-1" },
			{ status_code: "FINISHED" },
			{ id: "ig-post-1" },
		);
		const client = brotu({
			providers: [meta({ ...token, instagramAccountId: "ig1" })],
		});

		const { data, error } = await client.instagram.post({
			caption: "oi",
			mediaUrls: ["https://x/a.jpg"],
		});

		expect(error).toBeNull();
		expect(data?.id).toBe("ig-post-1");
		expect(calls.map((c) => c.url.replace(/\?.*/, ""))).toEqual([
			"https://graph.facebook.com/v21.0/ig1/media",
			"https://graph.facebook.com/v21.0/container-1",
			"https://graph.facebook.com/v21.0/ig1/media_publish",
		]);
	});

	it("builds a carousel from one container per item plus a parent", async () => {
		const calls = graph(
			{ id: "child-1" },
			{ id: "child-2" },
			{ id: "parent" },
			{ status_code: "FINISHED" },
			{ id: "ig-carousel" },
		);
		const client = brotu({
			providers: [meta({ ...token, instagramAccountId: "ig1" })],
		});

		const { data } = await client.instagram.post({
			caption: "duas fotos",
			mediaUrls: ["https://x/a.jpg", "https://x/b.jpg"],
		});

		expect(data?.id).toBe("ig-carousel");
		const parent = calls.find((c) => c.body?.includes("CAROUSEL"));
		expect(parent?.body).toContain("children=child-1%2Cchild-2");
	});

	it("reports a failed container instead of publishing it", async () => {
		graph({ id: "container-2" }, { status_code: "ERROR" });
		const client = brotu({
			providers: [meta({ ...token, instagramAccountId: "ig1" })],
		});

		const { error } = await client.instagram.post({
			caption: "oi",
			mediaUrls: ["https://x/a.mp4"],
		});

		expect(error?.code).toBe("platform_error");
		expect(error?.message).toContain("ERROR");
	});

	it("says Instagram has no text-only post", async () => {
		const client = brotu({
			providers: [meta({ ...token, instagramAccountId: "ig1" })],
		});

		const { error } = await client.instagram.post({ caption: "só texto" });

		expect(error?.code).toBe("invalid_request");
	});

	it("publishes a text thread without waiting on a container", async () => {
		const calls = graph({ id: "th-container" }, { id: "th-post" });
		const client = brotu({
			providers: [meta({ ...token, threadsUserId: "th1" })],
		});

		const { data } = await client.threads.post({ caption: "oi" });

		expect(data?.id).toBe("th-post");
		// Two calls, not three: no status poll for a text-only thread.
		expect(calls).toHaveLength(2);
		expect(calls[0]?.body).toContain("media_type=TEXT");
	});

	it("turns an expired token into auth_error, not platform_error", async () => {
		globalThis.fetch = mock(() =>
			Promise.resolve(
				new Response(
					JSON.stringify({ error: { message: "Session expired", code: 190 } }),
					{ status: 400 },
				),
			),
		) as unknown as typeof fetch;
		const client = brotu({ providers: [meta({ ...token, pageId: "p1" })] });

		const { error } = await client.facebook.post({ caption: "oi" });

		expect(error?.code).toBe("auth_error");
	});
});

describe("meta oauth", () => {
	it("is absent without app credentials, rather than half-working", () => {
		expect(
			brotu({ providers: [meta({ ...token })] }).facebook.oauth,
		).toBeUndefined();
	});

	it("asks only for the scopes that platform publishes with", () => {
		const client = brotu({
			providers: [
				meta({
					appId: "app",
					appSecret: "sec",
					redirectUri: "https://my.app/cb",
				}),
			],
		});

		const url = new URL(
			client.instagram.oauth?.authUrl({ state: "s1" }) as string,
		);

		expect(url.searchParams.get("scope")).toBe(
			"instagram_basic,instagram_content_publish,pages_show_list",
		);
		expect(url.searchParams.get("state")).toBe("s1");
		expect(url.searchParams.get("redirect_uri")).toBe("https://my.app/cb");
	});

	it("sends Threads to its own authorize host", () => {
		const client = brotu({
			providers: [meta({ appId: "app", appSecret: "sec" })],
		});

		expect(client.threads.oauth?.authUrl({ state: "s" })).toContain(
			"threads.net/oauth/authorize",
		);
	});
});

describe("meta webhooks", () => {
	const appSecret = "sec";
	const client = brotu({
		providers: [meta({ appSecret, webhookVerifyToken: "vt" })],
	});
	const hooks = client.instagram.webhooks;

	const sign = (body: string) =>
		`sha256=${createHmac("sha256", appSecret).update(body, "utf8").digest("hex")}`;

	it("echoes the challenge only for the right verify token", () => {
		const query = {
			"hub.mode": "subscribe",
			"hub.verify_token": "vt",
			"hub.challenge": "12345",
		};

		expect(hooks?.challenge?.(query)).toBe("12345");
		expect(
			hooks?.challenge?.({ ...query, "hub.verify_token": "errado" }),
		).toBeUndefined();
	});

	it("accepts a correct signature and rejects a tampered body", () => {
		const body = '{"object":"instagram","entry":[]}';
		const headers = { "x-hub-signature-256": sign(body) };

		expect(hooks?.verify({ rawBody: body, headers }).data).toBe(true);
		expect(hooks?.verify({ rawBody: `${body} `, headers }).error?.code).toBe(
			"auth_error",
		);
	});

	it("rejects a missing signature instead of trusting the body", () => {
		expect(hooks?.verify({ rawBody: "{}", headers: {} }).error?.code).toBe(
			"auth_error",
		);
	});

	it("parses each change into its own event", () => {
		const body = JSON.stringify({
			object: "instagram",
			entry: [
				{
					id: "ig1",
					changes: [
						{ field: "comments", value: { id: "c1" } },
						{ field: "mentions", value: { id: "m1" } },
					],
				},
			],
		});

		const { data } = hooks?.parse(body) ?? {};

		expect(data).toHaveLength(2);
		expect(data?.[0]?.type).toBe("comments.changed");
		expect(data?.[0]?.platform).toBe("instagram");
		expect(data?.[0]?.objectId).toBe("ig1");
	});
});

describe("youtube", () => {
	afterEach(() => mock.restore());

	it("needs a video, and says so", async () => {
		const client = brotu({ providers: [youtube({ accessToken: "t" })] });

		const { error } = await client.youtube.post({ caption: "só texto" });

		expect(error?.code).toBe("invalid_request");
	});

	it("errors clearly when no credential can be built", async () => {
		const client = brotu({ providers: [youtube({})] });

		const { error } = await client.youtube.post({
			caption: "x",
			mediaUrls: ["https://x/a.mp4"],
		});

		expect(error?.code).toBe("auth_error");
	});

	it("asks Google for offline access, or the refresh token never arrives", () => {
		const client = brotu({
			providers: [youtube({ clientId: "id", clientSecret: "sec" })],
		});

		const url = new URL(
			client.youtube.oauth?.authUrl({ state: "s" }) as string,
		);

		expect(url.searchParams.get("access_type")).toBe("offline");
		expect(url.searchParams.get("prompt")).toBe("consent");
	});

	it("uploads resumably and titles from the first caption line", async () => {
		const calls: { url: string; method: string; body?: unknown }[] = [];
		globalThis.fetch = mock((input: string | URL, init?: RequestInit) => {
			const url = String(input);
			calls.push({ url, method: init?.method ?? "GET", body: init?.body });

			if (url === "https://x/a.mp4") {
				return Promise.resolve(
					new Response(new Uint8Array([1, 2, 3]), {
						headers: { "content-type": "video/mp4" },
					}),
				);
			}
			if (url.includes("uploadType=resumable")) {
				return Promise.resolve(
					new Response("{}", {
						status: 200,
						headers: { location: "https://upload.session/1" },
					}),
				);
			}
			return Promise.resolve(
				new Response(JSON.stringify({ id: "vid-1" }), { status: 200 }),
			);
		}) as unknown as typeof fetch;

		const client = brotu({ providers: [youtube({ accessToken: "t" })] });

		const { data, error } = await client.youtube.post({
			caption: "Primeira linha\nresto da descrição",
			mediaUrls: ["https://x/a.mp4"],
		});

		expect(error).toBeNull();
		expect(data?.url).toBe("https://www.youtube.com/watch?v=vid-1");

		const init = calls.find((c) => c.url.includes("uploadType=resumable"));
		expect(JSON.parse(String(init?.body)).snippet.title).toBe("Primeira linha");
		// Private by default: publishing to the world should be a choice.
		expect(JSON.parse(String(init?.body)).status.privacyStatus).toBe("private");
		expect(calls.at(-1)?.method).toBe("PUT");
	});
});
