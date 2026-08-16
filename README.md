# Brotu SDK

One client for generative **video, image, speech and text**, talking to each
vendor's own API. You bring the keys; nothing is proxied and no aggregator sits
in between.

```
sdks/node/        TypeScript / Node client  →  @brotu/ai
catalog/          the model catalog as JSON, shared by every language
```

Python and Go clients are planned. They read `catalog/catalog.json` rather than
carrying their own copy of the model list. 81 models transcribed three times
would drift the first week someone adds one.

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

## Providers

| Provider | Video | Image | Speech | Text |
|---|:-:|:-:|:-:|:-:|
| Kling | ✓ | ✓ | ✓ | |
| BytePlus (Seedance, Seedream) | ✓ | ✓ | | |
| Qwen (Wan, HappyHorse) | ✓ | ✓ | ✓ | ✓ |
| Google (Veo, Gemini, Omni) | ✓ | ✓ | | |
| OpenAI | | ✓ | | |
| ElevenLabs | | | ✓ | |

See [`sdks/node/CATALOG.md`](./sdks/node/CATALOG.md) for every model with its
durations, resolutions, capabilities and price. It is generated from the
catalog, so it cannot drift from what the code supports.

## Working on this

Open an issue before you write a PR. See [CONTRIBUTING.md](./CONTRIBUTING.md)
for how to run the project, add a model, or add a provider.

```bash
cd sdks/node
bun install
bun run gate      # everything that must pass before code leaves the machine
```
