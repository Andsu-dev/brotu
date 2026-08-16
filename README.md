<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/logo.svg">
    <img src="docs/assets/logo-black.svg" alt="Brotu" width="280">
  </picture>
</p>

<p align="center">
  <strong>One client. Your keys. Their APIs.</strong><br>
  Generate video, image, speech and text without an aggregator in the middle.
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

Vendors do not agree on anything. Kling wants a JWT and a task id. BytePlus Seedance 400s if you send a field the model does not accept. Qwen spells resolutions in uppercase. Google Veo is a different host again.

`@brotu/ai` is one TypeScript client for all of them. You pass the keys you already have. The SDK talks to each vendor's own API. Nothing is proxied, nothing is marked up, no third party sits on the request.

81 models today: 37 video, 29 image, 9 speech, 6 text. Switching vendor is a model id, not a rewrite.

```ts
const { data, error } = await ai.video.submit({
  model: "kling/v2-6", // or seedance-1-0-pro-fast-251015, or wan2.7-t2v
  prompt: "a cat wearing sunglasses, cinematic, slow dolly in",
  duration: 5,
  aspectRatio: "16:9",
});
```

Same call shape. Same `{ data, error }`. Same job handle you can store and poll later.

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

```ts
import { brotuClient } from "@brotu/ai";

const ai = brotuClient({
  providers: {
    kling: { apiKey: process.env.KLING_API_KEY! },
    byteplus: { apiKey: process.env.ARK_API_KEY! },
  },
});
```

Only the providers you configure show up in `ai.models()`. No key, no model.

## Providers

| Provider | Video | Image | Speech | Text |
|---|:-:|:-:|:-:|:-:|
| Kling | ✓ | ✓ | ✓ | |
| BytePlus (Seedance, Seedream) | ✓ | ✓ | | |
| Qwen (Wan, HappyHorse) | ✓ | ✓ | ✓ | ✓ |
| Google (Veo, Gemini, Omni) | ✓ | ✓ | | |
| OpenAI | | ✓ | | |
| ElevenLabs | | | ✓ | |

Every model, duration, resolution and price: [`sdks/node/CATALOG.md`](./sdks/node/CATALOG.md). That file is generated from the catalog, so it cannot drift from what the code runs.

Python and Go clients are planned. They will read [`catalog/catalog.json`](./catalog/catalog.json) instead of carrying their own copy of the list.

## How a call works

Video takes minutes. The primary API is submit, then poll. `generate()` exists, but it holds the connection open for the whole run. Fine in a script. Wrong in a request handler.

```ts
const { data: job, error } = await ai.video.submit({
  model: "seedance-1-0-pro-fast-251015",
  prompt: "rain on neon pavement, handheld",
  duration: 5,
  resolution: "480p",
});

if (error) return console.error(error.code, error.message);

// later, another process, another day
const { data: result } = await ai.jobs.wait(job);
result.outputs[0].url;
```

Error codes: `unknown_model`, `missing_key`, `unsupported_provider`, `invalid_request`, `provider_error`, `timeout`.

Provider result URLs expire. Pass `storage` (any S3 API) and finished outputs land in your bucket.

## Repo

```
sdks/node/        @brotu/ai
catalog/          shared model catalog as JSON
```

```bash
cd sdks/node
bun install
bun run gate
```

Open an issue before a PR. See [CONTRIBUTING.md](./CONTRIBUTING.md).
