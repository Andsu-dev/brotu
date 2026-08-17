# @brotu/social

One TypeScript client for publishing to social platforms, with the OAuth and the webhooks that come with them.

Posting to Instagram is three API calls and a polling loop. Posting to YouTube is a resumable upload. Posting to Threads is a different host entirely. This package is one client in front of them, and it does not hide the parts that genuinely differ.

```bash
bun add @brotu/social
```

## Quick start

```ts
import { brotu } from "@brotu/social";
import { meta } from "@brotu/social/meta";
import { youtube } from "@brotu/social/youtube";

const client = brotu({
  providers: [
    meta({
      accessToken: process.env.META_TOKEN!,
      instagramAccountId: process.env.IG_ID!,
      pageId: process.env.FB_PAGE_ID!,
    }),
    youtube({
      refreshToken: process.env.YT_REFRESH_TOKEN!,
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
    }),
  ],
});

const { data, error } = await client.instagram.post({
  caption: "novo vídeo no ar",
  mediaUrls: ["https://cdn.example/reel.mp4"],
});

if (error) throw new Error(error.message);
console.log(data.id);
```

Every call returns `{ data, error }`. Nothing throws — same envelope as `@brotu/ai`, so a project using both never has to remember which one does what.

## One plugin per credential

A plugin owns a credential and every platform that credential reaches. One Meta app token reaches Facebook, Instagram and Threads, so `meta()` registers all three — asking for the same token three times would be theatre.

```ts
brotu({ providers: [meta({ … })] });
// → client.facebook, client.instagram, client.threads
```

The namespace is still per platform, because publishing is: Instagram has no text-only post, Facebook has three endpoints depending on the media, Threads lives on another host.

| Import | Platforms |
|---|---|
| `@brotu/social/meta` | `facebook`, `instagram`, `threads` |
| `@brotu/social/youtube` | `youtube` |

Subpath imports, so a project that never touches YouTube never bundles it.

## Posting

```ts
await client.youtube.post({ … });          // one platform
await client.post({ provider: "youtube" }); // when the platform is a variable
await client.postAll({ providers: ["instagram", "facebook"], caption: "oi" });
```

`postAll` never rejects. It hands back one `Result` per platform, in order, so a Facebook outage cannot hide the Instagram post that worked:

```ts
const results = await client.postAll({
  providers: ["instagram", "facebook", "youtube"],
  caption: "oi",
  mediaUrls: ["https://cdn.example/a.jpg"],
});

for (const { data, error } of results) {
  if (error) console.error(error.platform, error.code, error.message);
  else console.log(data.platform, data.url);
}
```

### The shared request

```ts
interface PostRequest {
  caption: string;
  mediaUrls?: string[];
  mediaTypes?: ("image" | "video")[]; // inferred from the extension otherwise
  title?: string;                     // YouTube needs one; others ignore it
  options?: { instagram?: {…}, youtube?: {…} };  // per-platform escape hatch
  metadata?: Record<string, string>;             // yours, never sent anywhere
}
```

`options` is merged into that platform's request and never reaches another. It is the pressure valve, so a field this package has not named yet cannot block you:

```ts
await client.youtube.post({
  caption: "…",
  mediaUrls: [url],
  options: { youtube: { privacyStatus: "public", tags: ["shorts"] } },
});
```

**YouTube uploads private by default.** Publishing to the world should be something you asked for.

## OAuth

The dance, without the part where you read three sets of platform docs:

```ts
const flow = client.instagram.oauth;   // undefined without app credentials

// 1. send the user
const state = crypto.randomUUID();     // store it; check it on the way back
redirect(flow.authUrl({ state }));

// 2. on your callback
const { data: token } = await flow.exchange({ code });

// 3. later, before it expires
const { data: fresh } = await flow.refresh({ token: token.accessToken });
```

Scopes are the ones that platform actually publishes with, nothing spare — Instagram gets `instagram_content_publish`, not the kitchen sink.

`oauth` is `undefined` when the plugin has no `appId`/`clientSecret`, rather than existing and failing at the third step.

**Meta has no refresh token.** You trade a short-lived token for a long-lived one, then trade that for another. `refresh` is the honest name for that call here.

**Google hands back a refresh token once.** `authUrl` sets `access_type=offline` and `prompt=consent`, or the second time you integrate it silently is not there.

## Webhooks

```ts
const hooks = client.instagram.webhooks;

// Subscription handshake (GET)
app.get("/webhooks/meta", (req, res) => {
  const echo = hooks.challenge(req.query);
  return echo ? res.send(echo) : res.sendStatus(403);
});

// Events (POST)
app.post("/webhooks/meta", (req, res) => {
  const { error } = hooks.verify({ rawBody: req.rawBody, headers: req.headers });
  if (error) return res.sendStatus(401);

  const { data: events } = hooks.parse(req.rawBody);
  for (const event of events) {
    console.log(event.platform, event.type, event.objectId);
  }
  res.sendStatus(200);
});
```

**`rawBody` must be the exact bytes received.** Parsing the JSON and re-serialising it changes them, and the signature stops matching — configure your framework to keep the raw body on this route.

The signature check is constant time. A comparison that returns on the first wrong byte tells an attacker how much of a forged signature was right.

## Errors

```ts
type SocialErrorCode =
  | "unconfigured_platform" // no plugin covers it
  | "invalid_request"       // wrong shape for that platform
  | "auth_error"            // missing, expired, or wrong scope
  | "platform_error"        // it accepted and then failed
  | "rate_limited"          // `retryAfterSeconds` when the platform says
  | "timeout"               // the upload outlived the wait; it may still land
  | "unsupported";          // the plugin cannot do that yet
```

An expired Meta token comes back as `auth_error`, not `platform_error`, so a retry loop can tell "get a new token" from "try again later".

## Accounts

```ts
const { data } = await client.facebook.accounts();
// [{ platform: "facebook", id: "123", displayName: "Minha Página" }]
```

## What is not here yet

- **TikTok, Twitter and LinkedIn.** The platform names exist in the type; no plugin ships for them. `post` returns `unconfigured_platform` and names what is missing.
- **The hosted path.** Publishing through Brotu with connected accounts — so you skip OAuth entirely — slots in as another provider plugin. It is not open yet.
- **Scheduling.** This publishes now. Anything later is your queue's job.

## License

MIT
