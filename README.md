# 🎬 VAULT — Home Streaming Server

A self-hosted MKV streaming server for your local network. Transcodes your movie library into HLS on-demand and serves them through a cinema-style web player — no Plex, no cloud, no subscription.

---

## Features

- **Instant playback** — starts streaming within seconds; the rest transcodes in the background
- **Pre-play track selection** — choose audio language and subtitle track before playback begins
- **Dual audio support** — pick Hindi, English, or any other track per-session; each is cached separately
- **Subtitle sync** — extracts VTT subtitles with correct HLS timestamp anchoring (`X-TIMESTAMP-MAP`)
- **GPU transcoding** — NVIDIA NVENC, AMD AMF, or Intel QSV for non-h264 sources (h264 is always stream-copied)
- **Smart cache** — LRU eviction keeps disk usage under a configurable limit
- **Local network access** — watch on any device on your home network (TV browser, phone, tablet)

---

## Requirements

- [Node.js](https://nodejs.org/) v18 or newer
- [FFmpeg](https://ffmpeg.org/download.html) (must be in PATH — `ffmpeg` and `ffprobe` accessible from terminal)

Verify both are installed:
```bash
node -v
ffmpeg -version
ffprobe -version
```

---

## Installation

```bash
git clone https://github.com/your-username/vault-streaming-server.git
cd vault-streaming-server
npm install
```

---

## Configuration

Open `server.js` and set the path to your MKV folder:

```js
const VIDEOS_DIR = 'E:/Movies/videos';   // ← change this
```

Other values you can tune at the top of `server.js`:

| Variable | Default | Description |
|---|---|---|
| `VIDEOS_DIR` | `E:/Movies/videos` | Path to your MKV library |
| `GPU_SELECT_TIMEOUT_S` | `10` | Seconds to wait for GPU selection before defaulting to CPU |

Cache limit is set in `cache_limit.txt` (created automatically on first run, default 20 GB):
```
20
```
Change the number to whatever GB limit you want.

---

## Running

```bash
npm start
```

On startup the server scans for GPU encoders and prompts you to pick one:

```
  Scanning for GPU encoders...
  Checking NVIDIA NVENC... ✓
  Checking AMD AMF... not available

  Select encoder for transcoding:
    [0] CPU  (libx264)
    [1] NVIDIA NVENC

  > auto-selects CPU in 8s
```

Type a number and press Enter — or wait for the countdown to auto-select CPU.

Then open your browser:
- **Local:** http://localhost:3000
- **Network:** http://192.168.x.x:3000 (shown in the startup banner)

---

## How It Works

1. Click a movie → pre-play modal loads track info via `ffprobe`
2. Select audio language and subtitle track, click **Play**
3. Server runs a single FFmpeg process for the whole file:
   - H264 video → stream-copied directly (no re-encode, no quality loss)
   - Other codecs → transcoded via GPU or CPU to H264
   - Selected audio track → AAC stereo
4. Player starts as soon as the first HLS segment (`seg00000.ts`) is written
5. FFmpeg continues in the background; a progress bar shows transcoding completion
6. Subtitles are extracted as WebVTT in parallel, ready before playback starts

Processed streams are cached in the `temp/` folder. Re-opening the same movie + audio combination loads instantly from cache.

---

## GPU Transcoding

GPU is **only used when the source video needs transcoding** (HEVC, AV1, MPEG-2, etc.). H264 sources are always stream-copied regardless of GPU selection — there is nothing to encode.

| Selection | Encoder | Hardware decode |
|---|---|---|
| NVIDIA NVENC | `h264_nvenc` | `cuda` |
| AMD AMF | `h264_amf` | `d3d11va` |
| Intel QSV | `h264_qsv` | `qsv` |
| CPU | `libx264` | software |

If a GPU encoder is listed by FFmpeg but fails the test-encode (driver mismatch, unsupported card), it is automatically excluded from the prompt.

---

## File Structure

```
vault-streaming-server/
├── server.js          # Express server + FFmpeg orchestration
├── public/
│   └── index.html     # Web player (VAULT UI)
├── temp/              # HLS segments cache (auto-created, gitignored)
├── cache_limit.txt    # Cache size limit in GB (auto-created)
├── package.json
└── README.md
```

> **Note:** `index.html` lives in `public/` so Express serves it as a static file.

---

## .gitignore

```
node_modules/
temp/
cache_limit.txt
```

---

## Tested On

- Windows 10/11 with Node 20
- FFmpeg 6.x / 7.x
- Chrome, Edge, Firefox (HLS.js handles playback)
- Safari on iOS (native HLS)