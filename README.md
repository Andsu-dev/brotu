# Brotu SDK

One client for generative **video, image, speech and text**, talking to each
vendor's own API. You bring the keys; nothing is proxied and no aggregator sits
in between.

```
sdks/node/        TypeScript / Node client  →  @brotu/ai
catalog/          the model catalog as JSON, shared by every language
```

Python and Go clients are planned. They read `catalog/catalog.json` rather than
carrying their own copy of the model list — 81 models transcribed three times
would drift the first week someone adds one.

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

```bash
cd sdks/node
bun install
bun run gate      # everything that must pass before code leaves the machine
```

`bun run gate` is the single check: no credentials in the tree, nothing internal
leaking into an open package, types, lint, tests, and both generated catalog
files still matching their source. It runs on pre-commit, in CI, and again
before publish.
