import { describeExpectedKeys } from "./env";

export const HELP = `brotu — generate video, image, speech and text

Get your key at https://brotu.app. Pass a vendor key you already have
and that model runs on the vendor. Everything else generates on Brotu.

Usage:
  brotu models [--type video|image|audio|text] [--json]
  brotu video  <prompt> -m <model> [options]
  brotu image  <prompt> -m <model> [options]
  brotu audio  <prompt> -m <model> [--voice <name>]
  brotu text   <prompt> -m <model> [--system <text>]
  brotu job wait <file.json> [--timeout <ms>]
  brotu job poll <file.json>
  brotu cost <video|image|audio|text> -m <model> [--duration <s>]

Video is submit-then-poll by default (writes a job file). Pass --wait to block.
Image, audio and text call generate and print the result.

Options:
  -m, --model         catalog id (required on generate commands)
      --duration      seconds (video)
      --aspect        16:9, 9:16, 1:1, …
      --resolution    720p, 1080p, 1K, …
      --image         first-frame, reference, or source image URL
      --video         source video URL (edit / upscale / interpolate)
      --quality       low | medium | high (image)
      --voice         speech voice
      --system        system prompt (text)
      --wait          wait for the job to settle
      --out <file>    write the job handle (default: brotu-job.json)
      --save <file>   download the first output
      --webhook <url> POST when the job settles
      --timeout <ms>  wait deadline (default: 420000)
  -j, --json          machine-readable output
  -h, --help          this text

Keys:
${describeExpectedKeys()}

  workspace    BROTU_WORKSPACE_ID    optional; otherwise the first workspace
  api url      BROTU_API_URL         optional; defaults to https://api.brotu.app
  webhook      BROTU_WEBHOOK_URL [, BROTU_WEBHOOK_SECRET]
  elevenlabs   ELEVENLABS_VOICE_ID   default voice when --voice is omitted
`;
