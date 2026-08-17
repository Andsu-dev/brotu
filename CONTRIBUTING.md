# Contributing

This repo ships `@brotu/ai` and `@brotu/cli`. Your Brotu key comes from the
platform. Vendor keys generate on the vendor when you have them.

## Issue first

Do not open a pull request without an issue.

1. Search [existing issues](https://github.com/Zorbi-Tech/brotu/issues) for a
   duplicate.
2. Open a new issue. Say what you want to change and why.
3. Wait for a maintainer to accept it. An accepted issue is labelled or
   explicitly assigned.
4. Only then open a PR. The first line of the PR body must be
   `Closes #<number>`.

PRs without a linked, accepted issue are closed. That includes new providers,
new models, refactors, and docs.

A good issue for a provider or model names:

- the vendor and the public API (URL of the docs)
- the model ids, and whether they are video, image, speech or text
- what the API accepts and rejects (fields, durations, resolutions)
- how billing works, if published
- why it belongs in this client (native API, not an aggregator)

## Run the project

You need [Bun](https://bun.sh). Node 18+ is enough to *use* the published
package; development runs on Bun.

```bash
git clone https://github.com/Zorbi-Tech/brotu.git
cd brotu
git config core.hooksPath .githooks

cd sdks/node
bun install
bun run gate

cd ../../cli
bun install
bun test
```

Useful scripts, all from `sdks/node`:

| Command | What it does |
|---|---|
| `bun test` | unit tests |
| `bun run typecheck` | `tsc --noEmit` |
| `bun run lint` | Biome on `src` |
| `bun run docs` | regenerate `CATALOG.md` and `catalog/catalog.json` |
| `bun run build` | ESM + CJS into `dist/` |
| `bun run gate` | secrets scan, leak scan, types, lint, tests, catalog drift |

`bun run gate` is the only check that matters. It runs on pre-commit, in CI,
and again before `npm publish`. Do not use `--no-verify` unless you know why.

Examples need real keys and are not part of the gate:

```bash
KLING_API_KEY=... bun run examples/01-basics.ts
ARK_API_KEY=...   bun run examples/03-storage-and-providers.ts
```

Never commit a key. The gate fails on Kling, Ark, Qwen, OpenAI, Google,
ElevenLabs and AWS prefixes.

## Layout

```
catalog/catalog.json          generated. Python and Go will read this.
sdks/node/src/providers/      model tables (data)
sdks/node/src/adapters/       HTTP adapters (behavior)
sdks/node/src/ports/          the shared generator interface
sdks/node/src/catalog.ts      built-in list + default base URLs
sdks/node/src/client.ts       wiring: keys -> adapter
sdks/node/CATALOG.md          generated from the catalog
```

The TypeScript tables are the source of truth. `catalog/catalog.json` and
`CATALOG.md` are generated. Edit the `.ts` files, then `bun run docs`.

## Add a model (existing provider)

Only if the issue is accepted.

1. Add the binding to `sdks/node/src/providers/<vendor>.models.ts`.
2. Put only fields that adapter actually sends. A field nothing reads looks
   supported and silently does nothing.
3. If the vendor 400s on unknown fields (BytePlus does), keep a per-family
   allow-list like `fieldsFor` in `byteplus.models.ts`.
4. Cover the new id in `sdks/node/src/__tests__/<vendor>.test.ts`.
5. Run `bun run docs` and `bun run gate`.

A model id in the catalog with no adapter that can run it fails the gate.

## Add a provider

Only if the issue is accepted. Copy the shape of a small existing one
(`openai` for sync image, `byteplus` for async video).

### 1. Model table

Create `sdks/node/src/providers/<id>.models.ts`.

- One catalog id per model the caller will type.
- `provider` on every entry must be the same string you will use as the key
  in `brotu({ providers: { <id>: { apiKey } } })`.
- Export a `*_CATALOG: AIModelConfig[]`.

### 2. Adapter

Create `sdks/node/src/adapters/<id>.adapter.ts` implementing
`ContentGeneratorPort`.

Rules the existing adapters follow, and the tests enforce:

- Talk to the vendor's own host when that key is present. Otherwise generate on Brotu.
- Return the shared `GenerationResult` / `GenerationOutput` shape. Extra
  vendor fields go in `output.raw`, never as sibling keys.
- Do not throw across the public client. The adapter may throw internally;
  `brotu` turns that into `{ data: null, error }`.
- If the vendor queues work, implement `completeJob` and throw `PendingJob`
  from `submit()` so `ai.video.submit` / `ai.jobs.poll` work.
- If the vendor answers in one request (OpenAI images, some Seedream calls),
  `submit()` still returns a job handle, already settled.
- Validate durations, resolutions and required inputs against the table
  before the HTTP call. Prefer a message that names the accepted values.
- Stamp `expiresAt` when the vendor documents a TTL.
- Default `baseUrl` to the public regional host. Let the caller override it.

### 3. Wire it

Touch every place the current six providers are listed:

| File | What to add |
|---|---|
| `src/catalog.ts` | `PROVIDER_BASE_URLS` + spread the new catalog into `BUILT_IN` |
| `src/client.ts` | `NATIVE_PROVIDERS` + a branch in `buildAdapter` |
| `src/index.ts` | export the adapter, options type, and catalog |
| `src/__tests__/<id>.test.ts` | body shape, validation, catalog ids |
| `src/__tests__/uniformity.test.ts` | include the adapter in `ADAPTERS` if it should share the surface |
| `scripts/gate.ts` | a secret prefix for that vendor, if they have one |
| root `README.md` | a row in the providers table |

Then:

```bash
cd sdks/node
bun run docs
bun run gate
```

### 4. What does not belong in a provider

Credits, quotas, accounts, and job persistence. Those are product concerns.
The SDK maps params to the vendor, polls if needed, and hands back URLs.

Vendor-only capabilities (Kling motion control, Google omni refine) sit
under `ai.<provider>.…`, not on the shared `video` / `image` surface. A
shared signature that lies is worse than a namespaced method.

## Pull requests

- Branch from `main`: `feat/…`, `fix/…`, `refactor/…`, `docs/…`.
- Conventional commits, English, imperative. No AI trailer
  (`Co-authored-By`, `Generated with`, and the rest).
- Keep the PR to the accepted issue. Do not mix a new provider with a
  drive-by rename.
- `bun run gate` must pass locally.

## License

By opening a PR you license the contribution under the MIT License in
[`LICENSE`](./LICENSE).
