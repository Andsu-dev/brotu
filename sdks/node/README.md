# @brotu/ai

One TypeScript client for generative image and video, talking to each vendor's own
API. You bring the keys; nothing is proxied, and no aggregator sits in between.

See [CATALOG.md](./CATALOG.md) for every model, with its durations, resolutions,
aspect ratios and capabilities. That file is generated from the catalog, so it
cannot drift from what the code actually supports.

## Use

```ts
import { brotuClient } from "@brotu/ai";

const ai = brotuClient({
  providers: {
    kling: { apiKey: process.env.KLING_API_KEY! },
  },
});

const { data: job, error } = await ai.video.submit({
  model: "kling/v2-6",
  prompt: "a cat wearing sunglasses, cinematic",
  duration: 5,
  aspectRatio: "16:9",
});

if (error) return console.error(error.code, error.message);
await db.jobs.insert(job); // serializable — put it anywhere
```

## Nothing throws

Every call returns `{ data, error }`. `data` is unusable until you narrow on
`error`, so a failure is not something you can forget to handle.

```ts
const { data, error } = await ai.jobs.wait(job);
if (error) {
  if (error.code === "timeout") return retryLater(job); // still running
  throw new Error(error.message);
}
data.outputs[0].url;
```

Error codes: `unknown_model`, `missing_key`, `unsupported_provider`,
`invalid_request`, `provider_error`, `timeout`.

## Jobs, not blocking calls

Video generation takes minutes, so the primary API is submit-then-poll. A job
handle is plain JSON: store it, and any later process can pick it up.

```ts
const { data: job } = await ai.video.submit({ model: "kling/v2-6", prompt });

// later, another process, another day
const { data: snapshot } = await ai.jobs.poll(job); // one check, no waiting
const { data: result } = await ai.jobs.wait(job);   // poll until it settles
```

`generate()` exists as the convenient version of the same thing, but it holds the
call open for the whole run — fine in a script, wrong in a request handler.

## Storage

Provider result URLs expire. Give the client a bucket and finished outputs are
copied into it, with `data.outputs[].url` pointing at your copy and the original
kept in `sourceUrl`.

```ts
const ai = brotuClient({
  providers: { kling: { apiKey: process.env.KLING_API_KEY! } },
  storage: {
    bucket: "my-bucket",
    region: "us-east-2",
    accessKeyId: process.env.S3_KEY!,
    secretAccessKey: process.env.S3_SECRET!,
    endpoint: "https://….r2.cloudflarestorage.com", // R2, MinIO, any S3 API
    publicUrl: "https://cdn.example.com",           // set it, and nothing is signed
  },
});
```

If one output fails to copy it keeps its provider URL rather than failing the
whole generation. `@aws-sdk/client-s3` is an optional peer dependency, loaded
only when you configure storage.

## Regions and self-hosting

Every provider has a default host. Override it per client:

```ts
providers: {
  kling: { apiKey, baseUrl: "https://api-beijing.klingai.com" },
}
```

## Adding a model

Models are data. Register your own, or patch a built-in one:

```ts
import { registerModels } from "@brotu/ai";

registerModels([
  { id: "kling/v3", provider: "kling", /* … */ },
]);
```

## Not in here

Credits, quotas, accounts and job persistence are product concerns, not client
concerns. Metering belongs on a server, where it can be trusted — not in an SDK
running on the caller's machine.
