<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/logo.svg">
    <img src="docs/assets/logo-black.svg" alt="Brotu" width="280">
  </picture>
</p>

<p align="center">
  <strong>One client. Your Brotu key. Their models.</strong><br>
  Video, image, speech, text, motion control, avatars and omni refine.<br>
  Bring a vendor key and generate on the vendor. Otherwise Brotu runs it.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@brotu/ai"><img alt="npm version" src="https://img.shields.io/npm/v/@brotu/ai?color=ef5e28"></a>
  <a href="https://www.npmjs.com/package/@brotu/ai"><img alt="npm downloads" src="https://img.shields.io/npm/dm/@brotu/ai?color=ef5e28&label=downloads"></a>
  <a href="https://www.npmjs.com/package/@brotu/ai"><img alt="npm totals" src="https://img.shields.io/npm/dt/@brotu/ai?color=111&label=total"></a>
  <a href="./LICENSE"><img alt="MIT" src="https://img.shields.io/npm/l/@brotu/ai?color=111"></a>
</p>

<p align="center">
  Built by <a href="https://x.com/andersonbrdev">@andersonbrdev</a>
  ·
  <a href="https://x.com/brotuApp">@brotuApp</a>
</p>

## What this is

Vendors do not agree on anything. Kling wants a task id. BytePlus Seedance 400s if you send a field the model does not accept. Qwen spells resolutions in uppercase. Google Veo is another host again.

`@brotu/ai` is one TypeScript client for all of them. Get your key at [brotu.app](https://brotu.app). Pass a vendor key you already have and that model hits the vendor. Everything else generates on Brotu.

97 models today: 37 video, 29 image, 12 speech, 19 text. Switching vendor is a model id, not a rewrite.

```ts
import { brotu } from "@brotu/ai";

const ai = brotu({
  apiKey: process.env.BROTU_API_KEY!, // brotu_sk_… from https://brotu.app
  providers: {
    kling: { apiKey: process.env.KLING_API_KEY! },
    byteplus: { apiKey: process.env.ARK_API_KEY! },
    google: { apiKey: process.env.GEMINI_API_KEY! },
    openai: { apiKey: process.env.OPENAI_API_KEY! },
  },
  webhook: {
    url: "https://my.app/hooks/brotu",
    secret: process.env.BROTU_WEBHOOK_SECRET,
  },
});
```

Your Brotu key opens the catalog. A vendor key, when you have one, generates on that vendor.

The portable surface is the same on every vendor:

| Call | What it does |
|---|---|
| `ai.video` | text-to-video, image-to-video, edit |
| `ai.image` | text-to-image, image-to-image |
| `ai.text` | chat / completions |
| `ai.audio` | text-to-speech |
| `ai.jobs` | poll or wait on a stored handle |
| `ai.webhook` | register a URL the client POSTs when a generation settles |
| `hooks` | run your own code in-process when a generation starts, settles or fails |
| `ai.estimateCost` | units (and USD, when the catalog has a verified rate) |
| `brotu` CLI | same client in the terminal: `models`, `video`, `image`, `job wait` |

Vendor-only work sits under a namespace that only exists when that key is set:

| Call | What it does |
|---|---|
| `ai.kling.motionControl` | your character, someone else's movement |
| `ai.kling.omniVideo` | multimodal video with `@id` references |
| `ai.kling.avatar` | portrait + audio = talking head |
| `ai.kling.outpainting` | expand an image canvas |
| `ai.kling.imageOmni` | compose / edit across references |
| `ai.google.omniVideo` | generate a video, then refine it by talking to it |

Every public method returns `{ data, error }`. `data` is unusable until you narrow on `error`.

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

## Video

`submit` queues the work and returns a job handle. `generate` is submit + wait in one call. Video takes minutes, so `submit` is the one you want in a request handler.

```ts
const { data: job, error } = await ai.video.submit({
  model: "kling/v2-6", // or seedance-1-0-pro-fast-251015, wan2.7-t2v, veo-3.1-fast-generate-preview
  prompt: "a cat wearing sunglasses, cinematic, slow dolly in",
  duration: 5,
  aspectRatio: "16:9",
  resolution: "720p",
});

if (error) return console.error(error.code, error.message);

const { data } = await ai.jobs.wait(job);
data.outputs[0].url;
```

Image-to-video is the same call with a first frame:

```ts
await ai.video.submit({
  model: "seedance-1-0-pro-fast-251015",
  prompt: "the camera pushes in",
  imageUrl: "https://example.com/frame.png",
  duration: 5,
  resolution: "480p",
});
```

## Image

Synchronous on most vendors. `submit` still returns a job, already settled.

```ts
const { data, error } = await ai.image.generate({
  model: "gpt-image-2",
  prompt: "a ginger cat on a windowsill, soft light",
  aspectRatio: "1:1",
  quality: "medium",
});

if (error) return console.error(error.message);
data.outputs[0].url; // data URI on OpenAI / Gemini, URL on others
```

## Text

OpenAI goes through the Responses API (`gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`). Gemini goes through the Interactions API (`gemini-3.7-flash` and the rest of the current ladder). Qwen uses its OpenAI-compatible chat surface.

```ts
const { data, error } = await ai.text.generate({
  model: "gpt-5.6-luna",
  prompt: "summarize this in two sentences",
  systemPrompt: "be brief",
  maxTokens: 200,
});

if (error) return console.error(error.message);
data.outputs[0].raw?.text;
```

Vision is the same call with `referenceImages`.

Text has no file, so the output is a `data:text/plain` URI plus `raw.text`. The bill is per token: `estimateCost` reports the rate and refuses to guess the total.

## Audio (text-to-speech)

`prompt` is the text to speak. Gemini TTS has 30 official voices (default `Kore`). Qwen and ElevenLabs each have their own list.

```ts
const { data, error } = await ai.audio.generate({
  model: "gemini-3.1-flash-tts-preview",
  prompt: "Say cheerfully: good morning",
  voice: "Puck",
});

if (error) return console.error(error.message);
data.outputs[0].url;
```

ElevenLabs needs an explicit voice. Gemini and Qwen pick a default if you omit it.

Live / realtime WebSocket APIs are not on this surface. They do not fit `generate`.

## CLI

One line, no Node required once a release binary exists:

```bash
curl -fsSL https://raw.githubusercontent.com/Zorbi-Tech/brotu/main/install.sh | bash
```

That drops `brotu` in `/usr/local/bin` (or `~/.local/bin`). The CLI lives in [`cli/`](./cli) (`@brotu/cli`), not inside `@brotu/ai`. If there is no binary for your machine it falls back to npm/bun.

Or, with Node already installed:

```bash
npx @brotu/cli --help
npm i -g @brotu/cli
```

```bash
brotu models
brotu video "a cat, cinematic" -m kling/v2-6 --duration 5
brotu job wait brotu-job.json --save out.mp4
```

`BROTU_API_KEY` comes from [brotu.app](https://brotu.app). Vendor keys (`KLING_API_KEY`, `ARK_API_KEY`, `GEMINI_API_KEY`, `OPENAI_API_KEY`, `QWEN_API_KEY`, `ELEVENLABS_API_KEY`) generate on the vendor when you have them. Video submits and writes a job file. `--wait` blocks.

## Jobs

A job handle is plain JSON. Store it, hand it to another process, poll it tomorrow.

```ts
const { data: snapshot } = await ai.jobs.poll(job); // one check
const { data: result } = await ai.jobs.wait(job, { timeoutMs: 420_000 });
```

`generate()` holds the connection open for the whole run. Fine in a script. Wrong behind HTTP.

## Webhook

Register a URL on the client. When `generate`, `jobs.wait` or a terminal `jobs.poll` settles, the SDK POSTs the result there. A down hook never fails the generation.

```ts
const ai = brotu({
  apiKey: process.env.BROTU_API_KEY!,
  providers: { kling: { apiKey: process.env.KLING_API_KEY! } },
  webhook: {
    url: "https://my.app/hooks/brotu",
    secret: process.env.BROTU_WEBHOOK_SECRET,
  },
});

// later, or instead of the constructor option
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

`generation.failed` carries `error: { code, message }` and no outputs. Timeouts and routing errors (unknown model, missing key) do not fire the hook — nothing came back.

Error codes: `unknown_model`, `missing_key`, `unsupported_provider`, `invalid_request`, `provider_error`, `timeout`.

## Hooks

A webhook needs an endpoint. A hook is a function, so it runs inside your process — send the email, write the row, push to the queue, no HTTP round trip. Both fire at the same moments, and a hook that throws never fails the generation.

```ts
const ai = brotu({
  apiKey: process.env.BROTU_API_KEY!,
  providers: { kling: { apiKey: process.env.KLING_API_KEY! } },
  hooks: {
    onVideoLoading: (e) => console.log("generating", e.model),
    onVideoSuccess: (e) => sendEmail("your video is ready", e.outputs?.[0]?.url),
    onVideoError: (e) => sendEmail("your video failed", e.error?.message),
  },
});
```

One optional callback per kind and stage — twelve names, all typed:

| | `Loading` | `Success` | `Error` |
|---|---|---|---|
| **image** | `onImageLoading` | `onImageSuccess` | `onImageError` |
| **video** | `onVideoLoading` | `onVideoSuccess` | `onVideoError` |
| **audio** | `onAudioLoading` | `onAudioSuccess` | `onAudioError` |
| **text** | `onTextLoading` | `onTextSuccess` | `onTextError` |

`Loading` fires once the model is routed, before the provider is called. `Success` and `Error` fire wherever the webhook fires — `generate`, `jobs.wait`, a terminal `jobs.poll` — deduped by job id, so a job settles once no matter how often you poll it.

Every hook receives the same event:

```ts
{
  kind: "video",
  stage: "Success",
  provider: "kling",
  model: "kling/v2-6",
  jobId: "task-1",
  outputs: [{ url: "https://…", mimeType: "video/mp4" }],
  error: undefined,          // { code, message } on Error
  metadata: { userId: "42" }, // whatever you passed on the request
  processingTimeMs: 8100,
  at: "2026-08-16T12:00:00.000Z",
}
```

## Motion control, avatars, omni

These have no portable equivalent, so they are not on `ai.video`. The namespace is missing unless that key is configured.

### Kling: motion control

Your character, someone else's movement.

```ts
if (!ai.kling) throw new Error("needs a kling key");

const { data: job, error } = await ai.kling.motionControl({
  model: "kling-2.6",
  imageUrl: "https://example.com/character.png",
  videoUrl: "https://example.com/dance.mp4",
  characterOrientation: "video", // `video` allows 30s; `image` caps at 10s
  resolution: "1080p",
});

if (!error) {
  const { data } = await ai.jobs.wait(job);
  data.outputs[0].url;
}
```

### Kling: talking head

```ts
const { data: job } = await ai.kling.avatar({
  imageUrl: "https://example.com/portrait.png",
  soundFileUrl: "https://example.com/voice.mp3",
  prompt: "warm, speaking to camera, slight head movement",
  mode: "pro",
});
```

### Kling: omni video

Everything in the prompt is addressed by `@id`.

```ts
const { data: job } = await ai.kling.omniVideo({
  model: "kling-3.0-omni",
  prompt: "@hero walks through the scene from @backdrop, cinematic",
  references: [
    { type: "refer_image", url: "https://example.com/hero.png", id: "hero" },
    { type: "refer_image", url: "https://example.com/street.png", id: "backdrop" },
  ],
  resolution: "1080p",
  duration: 10,
  aspectRatio: "9:16",
});
```

### Kling: outpainting and image omni

```ts
await ai.kling.outpainting({
  imageUrl: "https://example.com/square.png",
  up: 0,
  down: 0,
  left: 0.5,
  right: 0.5,
  prompt: "continue the street scene naturally",
});

await ai.kling.imageOmni({
  prompt: "<<<image_1>>> on marble, studio light",
  imageUrls: ["https://example.com/can.png"],
});
```

### Google: conversational Omni

Generate a video, then keep editing it by talking to the result. Pass `interactionId` back as `previousInteractionId`.

```ts
if (!ai.google) throw new Error("needs a google key");

const first = await ai.google.omniVideo({
  model: "gemini-omni-flash-preview",
  prompt: "a cat walks through rain at night",
});

const edited = await ai.google.omniVideo({
  model: "gemini-omni-flash-preview",
  prompt: "make it dawn, keep the camera",
  previousInteractionId: first.data?.interactionId,
});
```

## Cost

Always reports the billable units. Reports USD only where the catalog has a verified rate. Token models return `usd: null` on purpose: the total depends on how much the model writes.

```ts
const { data } = await ai.estimateCost("video", {
  model: "kling/v3",
  prompt: "x",
  duration: 5,
  resolution: "720p",
});
data.units;
data.usd; // number, or null
```

## Storage

Provider result URLs expire. Give the client a bucket and finished outputs land there. `outputs[].url` points at your copy; the original stays in `sourceUrl`.

```ts
const ai = brotu({
  apiKey: process.env.BROTU_API_KEY!,
  providers: { kling: { apiKey: process.env.KLING_API_KEY! } },
  storage: {
    bucket: "my-bucket",
    region: "us-east-2",
    accessKeyId: process.env.S3_KEY!,
    secretAccessKey: process.env.S3_SECRET!,
    endpoint: "https://....r2.cloudflarestorage.com",
    publicUrl: "https://cdn.example.com",
  },
});
```

`@aws-sdk/client-s3` is an optional peer. If one output fails to copy, that output keeps the provider URL instead of failing the whole generation.

## Providers

| Provider | Video | Image | Speech | Text | Extra |
|---|:-:|:-:|:-:|:-:|---|
| Kling | ✓ | ✓ | ✓ | | motion, avatar, omni, outpainting |
| BytePlus (Seedance, Seedream) | ✓ | ✓ | | | |
| Qwen (Wan, HappyHorse) | ✓ | ✓ | ✓ | ✓ | |
| Google (Veo, Gemini, Omni) | ✓ | ✓ | ✓ | ✓ | conversational omni |
| OpenAI | | ✓ | | ✓ | |
| ElevenLabs | | | ✓ | | |

Every model, duration, resolution and price: [`sdks/node/CATALOG.md`](./sdks/node/CATALOG.md). Generated from the catalog, so it cannot drift from what the code runs.

Override a host per client when you are on another region:

```ts
providers: {
  kling: { apiKey, baseUrl: "https://api-beijing.klingai.com" },
}
```

Register extra models, or patch a built-in one, by id:

```ts
import { registerModels } from "@brotu/ai";

registerModels([{ id: "kling/v3", provider: "kling" /* ... */ }]);
```

## Repo

```
sdks/node/        @brotu/ai
cli/              @brotu/cli
catalog/          shared model catalog as JSON
```

Python and Go clients are planned. They will read [`catalog/catalog.json`](./catalog/catalog.json).

```bash
cd sdks/node && bun install && bun run gate
cd ../../cli && bun install && bun test
```

Open an issue before a PR. See [CONTRIBUTING.md](./CONTRIBUTING.md).

## Not in here

Credits, quotas, accounts and job persistence are product concerns. Metering belongs on a server.
