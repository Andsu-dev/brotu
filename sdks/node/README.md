<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/Zorbi-Tech/brotu-sdk/main/docs/assets/logo.svg">
    <img src="https://raw.githubusercontent.com/Zorbi-Tech/brotu-sdk/main/docs/assets/logo-black.svg" alt="Brotu" width="280">
  </picture>
</p>

<p align="center">
  <strong>One TypeScript client for video, image, speech, text and vendor extras.</strong><br>
  You bring the keys. Each call hits the vendor's own API.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@brotu/ai"><img alt="npm version" src="https://img.shields.io/npm/v/@brotu/ai?color=ef5e28"></a>
  <a href="https://www.npmjs.com/package/@brotu/ai"><img alt="npm downloads" src="https://img.shields.io/npm/dm/@brotu/ai?color=ef5e28&label=downloads"></a>
  <a href="https://www.npmjs.com/package/@brotu/ai"><img alt="npm totals" src="https://img.shields.io/npm/dt/@brotu/ai?color=111&label=total"></a>
  <a href="https://github.com/Zorbi-Tech/brotu-sdk/blob/main/LICENSE"><img alt="MIT" src="https://img.shields.io/npm/l/@brotu/ai?color=111"></a>
</p>

<p align="center">
  Built by <a href="https://x.com/andersonbrdev">@andersonbrdev</a>
  ·
  <a href="https://x.com/brotuApp">@brotuApp</a>
</p>

Kling, Seedance, Wan, Veo, Gemini, gpt-image and ElevenLabs all speak different HTTP. This package is one `brotuClient` in front of them. No proxy.

97 models: 37 video, 29 image, 12 speech, 19 text. Full table in [CATALOG.md](./CATALOG.md). That file is generated from the catalog, so it cannot drift from what the code supports.

## Install

```bash
bun add @brotu/ai
```

```bash
npm i @brotu/ai
```

```bash
pnpm add @brotu/ai
```

## Client

```ts
import { brotuClient } from "@brotu/ai";

const ai = brotuClient({
  providers: {
    kling: { apiKey: process.env.KLING_API_KEY! },
    byteplus: { apiKey: process.env.ARK_API_KEY! },
    google: { apiKey: process.env.GEMINI_API_KEY! },
    openai: { apiKey: process.env.OPENAI_API_KEY! },
    qwen: { apiKey: process.env.QWEN_API_KEY! },
    elevenlabs: { apiKey: process.env.ELEVENLABS_API_KEY! },
  },
  webhook: {
    url: "https://my.app/hooks/brotu",
    secret: process.env.BROTU_WEBHOOK_SECRET,
  },
});
```

Only configured providers appear in `ai.models()`.

Every public call returns `{ data, error }`. `data` is unusable until you narrow on `error`.

| Surface | Methods |
|---|---|
| `ai.video` | `submit` / `generate` |
| `ai.image` | `submit` / `generate` |
| `ai.text` | `submit` / `generate` |
| `ai.audio` | `submit` / `generate` |
| `ai.jobs` | `poll` / `wait` |
| `ai.webhook` | `set` / `clear` / `get` |
| `ai.estimateCost` | units, and USD when verified |
| `ai.kling` | `motionControl`, `omniVideo`, `avatar`, `outpainting`, `imageOmni` |
| `ai.google` | `omniVideo` (conversational refine) |

`ai.kling` and `ai.google` exist only when that key is set.

## Video

`submit` returns a job handle. `generate` waits. Video takes minutes, so do not `generate` inside a request handler.

```ts
const { data: job, error } = await ai.video.submit({
  model: "kling/v2-6",
  prompt: "a cat wearing sunglasses, cinematic",
  duration: 5,
  aspectRatio: "16:9",
});

if (error) return console.error(error.code, error.message);
await db.jobs.insert(job);

const { data } = await ai.jobs.wait(job);
data.outputs[0].url;
```

Image-to-video is the same shape with `imageUrl`.

## Image

```ts
const { data, error } = await ai.image.generate({
  model: "gpt-image-2",
  prompt: "a ginger cat on a windowsill, soft light",
  quality: "medium",
});
```

OpenAI and Gemini return a data URI. Give the client `storage` if you want a real URL.

## Text

```ts
const { data, error } = await ai.text.generate({
  model: "gpt-5.6-luna",
  prompt: "summarize this in two sentences",
  systemPrompt: "be brief",
  maxTokens: 200,
});

data?.outputs[0].raw?.text;
```

OpenAI: `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna` on the Responses API.
Gemini: `gemini-3.7-flash` and the current ladder on the Interactions API.
Qwen: `qwen3.8-max`, `qwen-plus`, `qwen-turbo`, and the rest.

Pass `referenceImages` for vision. The output is `data:text/plain` plus `raw.text`. Token totals are only known after the call, so `estimateCost` reports the rate and leaves `usd` null.

## Audio

`prompt` is the spoken text.

```ts
const { data, error } = await ai.audio.generate({
  model: "gemini-3.1-flash-tts-preview",
  prompt: "Say cheerfully: good morning",
  voice: "Puck",
});
```

Gemini TTS: 30 official voices, default `Kore`.
Qwen: `Cherry`, `Ethan`, and the rest on `qwen3-tts-flash`.
ElevenLabs: you must pass `voice`. There is no default.

Realtime / Live WebSocket models are not on this surface.

## Jobs

```ts
const { data: snapshot } = await ai.jobs.poll(job);
const { data: result } = await ai.jobs.wait(job, { timeoutMs: 420_000 });

if (result === undefined && snapshot?.status === "pending") {
  // still running
}
```

## Webhook

Register a URL on the client. When `generate`, `jobs.wait` or a terminal `jobs.poll` settles, the SDK POSTs the result there. A down hook never fails the generation.

```ts
ai.webhook.set("https://my.app/hooks/brotu");
ai.webhook.clear();
```

Per request, if one generation should go somewhere else:

```ts
await ai.video.submit({
  model: "kling/v2-6",
  prompt: "a cat",
  webhook: "https://my.app/hooks/this-one",
});
```

The POST is JSON. Check `x-brotu-event` and, if you set a secret, `x-brotu-webhook-secret`.

```json
{
  "event": "generation.succeeded",
  "jobId": "task-1",
  "provider": "kling",
  "model": "kling/v2-6",
  "kind": "video",
  "outputs": [{ "url": "https://…", "mimeType": "video/mp4" }],
  "completedAt": "2026-08-16T12:00:00.000Z"
}
```

`generation.failed` carries `error: { code, message }` and no outputs. Timeouts and routing errors do not fire the hook.

Error codes: `unknown_model`, `missing_key`, `unsupported_provider`, `invalid_request`, `provider_error`, `timeout`.

## Motion control, avatars, omni

Not on `ai.video`. A shared signature would be a lie.

```ts
if (!ai.kling) throw new Error("needs a kling key");

const { data: motion } = await ai.kling.motionControl({
  model: "kling-2.6",
  imageUrl: "https://example.com/character.png",
  videoUrl: "https://example.com/dance.mp4",
  characterOrientation: "video",
  resolution: "1080p",
});

const { data: talking } = await ai.kling.avatar({
  imageUrl: "https://example.com/portrait.png",
  soundFileUrl: "https://example.com/voice.mp3",
  prompt: "warm, speaking to camera",
  mode: "pro",
});

const { data: omni } = await ai.kling.omniVideo({
  model: "kling-3.0-omni",
  prompt: "@hero walks through @backdrop",
  references: [
    { type: "refer_image", url: "https://example.com/hero.png", id: "hero" },
    { type: "refer_image", url: "https://example.com/street.png", id: "backdrop" },
  ],
  duration: 10,
  aspectRatio: "9:16",
});

await ai.kling.outpainting({
  imageUrl: "https://example.com/square.png",
  up: 0,
  down: 0,
  left: 0.5,
  right: 0.5,
  prompt: "continue the street",
});
```

Google Omni is the one model you refine by talking to the previous result:

```ts
if (!ai.google) throw new Error("needs a google key");

const first = await ai.google.omniVideo({
  model: "gemini-omni-flash-preview",
  prompt: "a cat walks through rain at night",
});

await ai.google.omniVideo({
  model: "gemini-omni-flash-preview",
  prompt: "make it dawn, keep the camera",
  previousInteractionId: first.data?.interactionId,
});
```

## Cost and storage

```ts
const { data } = await ai.estimateCost("video", {
  model: "kling/v3",
  prompt: "x",
  duration: 5,
  resolution: "720p",
});
```

Provider URLs expire. Pass `storage` (any S3 API) and outputs land in your bucket. `outputs[].url` is your copy; `sourceUrl` is the original. `@aws-sdk/client-s3` is an optional peer.

```ts
storage: {
  bucket: "my-bucket",
  region: "us-east-2",
  accessKeyId: process.env.S3_KEY!,
  secretAccessKey: process.env.S3_SECRET!,
  endpoint: "https://....r2.cloudflarestorage.com",
  publicUrl: "https://cdn.example.com",
}
```

## Regions and extra models

```ts
providers: {
  kling: { apiKey, baseUrl: "https://api-beijing.klingai.com" },
}
```

```ts
import { registerModels } from "@brotu/ai";

registerModels([{ id: "kling/v3", provider: "kling" /* ... */ }]);
```

Credits, quotas, accounts and job persistence stay on your server. This package maps params, polls if needed, and hands back URLs.
