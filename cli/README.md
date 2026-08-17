# `@brotu/cli`

Terminal for [`@brotu/ai`](../sdks/node). Your Brotu key. Vendor keys generate on the vendor.

```bash
curl -fsSL https://raw.githubusercontent.com/Zorbi-Tech/brotu/main/install.sh | bash
```

```bash
cd cli
bun install
bun run dev --help
```

```bash
export BROTU_API_KEY=brotu_sk_...   # from https://brotu.app
export KLING_API_KEY=...            # generates on Kling when you have it
brotu models
brotu video "a cat, cinematic" -m kling/v2-6 --duration 5
brotu job wait brotu-job.json --save out.mp4
```

`BROTU_API_KEY` comes from [brotu.app](https://brotu.app). Vendor keys (`KLING_API_KEY`, `ARK_API_KEY`, `GEMINI_API_KEY`, `OPENAI_API_KEY`, `QWEN_API_KEY`, `ELEVENLABS_API_KEY`, `TOPAZ_API_KEY`) generate on the vendor when you have them.
