# AI-HUB

An Electron + React desktop app that orchestrates [ComfyUI](https://github.com/comfyanonymous/ComfyUI) for AI image and video generation, with a conversational VLM-powered chat, an autonomous video director, and voice input/output.

Built around Wan 2.2 SVI Pro for long-form video (1 min+) with seamless end-frame continuation.

## Screenshots

### AI Director
Autonomous T2I → I2V → Extend pipeline with planner review and per-segment LoRA selection.

![AI Director](App%20images%20and%20demo/AI%20Director.png)

### Studio
Manual generation with preset-driven model + LoRA stacks, HireFix, and image-to-video.

![Studio](App%20images%20and%20demo/STUDIO.png)

### Chat
VLM conversation with tool use — generates images inline, speaks responses aloud.

![Chat](App%20images%20and%20demo/Chat.png)

### Presets
Sidebar-based preset management with descriptions, LoRA pools, and smart selection.

![Presets](App%20images%20and%20demo/Presets.png)

### Gallery
Browse generated, imported, and Director project content.

![Gallery](App%20images%20and%20demo/Gallery.png)

### Demo video

[▶ Watch the AI Director demo](App%20images%20and%20demo/AI%20Director%20Demo.mp4) — autonomous segment-by-segment generation in action.

> GitHub renders the video inline once you click the link. To embed it as a player in this README, open the file on GitHub's web UI and drag-drop it into an edit of the README — GitHub will host it on `user-images.githubusercontent.com` and replace the link with a `<video>` block.

## Features

- **Studio** — manual text-to-image with SDXL and Qwen families, per-preset LoRA stacks, HireFix upscaling, image-to-video animation
- **AI Director** — autonomous video pipeline (Planner → LoRA Scan → T2I → Body Fix → HireFix → I2V → Extend ×N → Review) with Premiere-style clip layout
- **Chat** — VLM conversation with tool use (`<generate>` image generation, voice input/output via Whisper + Kokoro/Piper)
- **Presets** — sidebar-based preset management with descriptions, LoRA pools, and smart preset selection
- **Gallery** — browse generated, imported, and Director project content
- **First-run wizard** — one-click install of the VLM runtime, voice server, Whisper, and Kokoro; walks through ComfyUI path configuration and GPU-aware VLM auto-optimization

## Stack

- Electron 28 + React 18 + Vite 5 + Tailwind 3 + Zustand
- Python FastAPI servers for VLM (llama-cpp-python) and Voice (Whisper.cpp + Piper/Kokoro)
- Vitest for unit tests (226 tests across 15 files)

## Prerequisites

- [Node.js 18+](https://nodejs.org/)
- [Python 3.11](https://www.python.org/downloads/) (the llama-cpp-python wheel is pinned to cp311)
- [ComfyUI](https://github.com/comfyanonymous/ComfyUI) running locally
- An NVIDIA GPU with CUDA for VLM inference (8 GB+ recommended)

## ⚠️ Important — Install the bundled custom nodes first

The workflows in this repo rely on a set of ComfyUI custom nodes (Wan-SVI2Pro-FLF, PainterI2Vadvanced, PainterLongVideo, KJNodes, rgthree, Easy-Use, Comfyroll, VideoHelperSuite, MTB, Crystools, WanVideoWrapper, and more). All of them ship inside the repo's `custom_nodes/` folder.

Follow these two steps in order — doing them in this order avoids version-mismatch conflicts between packs you may already have installed and the ones bundled here.

### Step 1 — Copy the folder into ComfyUI (replace when prompted)

Move every subfolder inside the repo's `custom_nodes/` into your `ComfyUI/custom_nodes/` directory.

**If you already have one of the packs installed, choose Replace / Overwrite.** This keeps everyone on a single known-good baseline. Don't worry about losing updates — Step 2 pulls the latest version of every pack.

**Windows (PowerShell):**

```powershell
$src = "custom_nodes"
$dst = "C:\path\to\ComfyUI\custom_nodes"   # ← change this
Get-ChildItem $src -Directory | Where-Object { $_.Name -ne "__pycache__" } | ForEach-Object {
    Copy-Item -Recurse -Force -Path $_.FullName -Destination $dst
    Write-Host "Copied: $($_.Name)"
}
```

**macOS / Linux (bash):**

```bash
SRC="custom_nodes"
DST="/path/to/ComfyUI/custom_nodes"   # ← change this
for d in "$SRC"/*/; do
  name=$(basename "$d")
  [ "$name" = "__pycache__" ] && continue
  cp -rf "$d" "$DST/" && echo "Copied: $name"
done
```

**Manual (drag-and-drop):** open both folders side-by-side, drag all subfolders over. When the OS asks about existing folders, choose **Replace / Merge**.

### Step 2 — Start ComfyUI and update every node from the Manager

This is the important part — **do not skip it**.

1. Launch ComfyUI (so it can install each pack's Python dependencies on first run).
2. Open **ComfyUI Manager** (the Manager button in the main UI).
3. Click **"Update All"** (or "Update All Custom Nodes").
4. When it finishes, **restart ComfyUI**.

Updating through the Manager reconciles every pack to its latest working version and fixes any file conflicts introduced by the copy in Step 1. This is why overwriting in Step 1 is safe — Step 2 brings everything back to a clean, up-to-date state.

Once ComfyUI restarts cleanly, launch AI-HUB.

## Quick start

```bash
git clone https://github.com/alhajrimh883-ai/AI-HUB.git
cd ai-hub
npm install
npm run dev
```

The app launches with a first-run wizard that walks you through:

1. Picking your ComfyUI launcher (`.bat`/`.sh`) and root/models folders
2. Detecting your GPU and applying a recommended VLM profile
3. One-click install of VLM runtime, voice server, Whisper base, and Kokoro weights

After install, open **Presets → VLM** and point it at any GGUF vision-language model (Qwen2-VL, Phi-3-Vision, etc.) you already have.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Start Vite + Electron in dev mode with HMR |
| `npm run build` | Build production app via electron-builder |
| `npm test` | Run the Vitest suite once |
| `npm run test:watch` | Run tests in watch mode |

## Project layout

```
electron/           Electron main process + preload + IPC handlers
  ipc/              IPC handler modules (comfy, voice, vlm, settings, fs)
  main.js           App entry + window/tray setup
  preload.js        contextBridge whitelist
src/
  App.jsx           Top-level router (first-run wizard gate)
  components/       Per-tab React UIs (Studio, Director, Chat, Presets, Gallery, Settings)
  lib/              Pure logic: pipeline phases, chat pipeline, workflow builders,
                    smart-select, VLM auto-optimize, clipboard, first-run installer
tests/              Vitest unit tests for pure logic modules
workflow/           ComfyUI workflow JSON templates (T2I, Edit, HireFix, I2V, etc.)
custom_nodes/       ComfyUI custom-node packs used by the workflows
                    (copy into ComfyUI/custom_nodes, replacing existing folders,
                    then run Manager → Update All to reconcile versions)
vlm_server.py       FastAPI VLM inference server (llama-cpp-python)
voice_server.py     FastAPI voice server (Whisper STT + Kokoro/Piper TTS)
```

## Re-running the first-run wizard

The wizard runs once on first launch. To run it again (e.g. to reconfigure paths or reinstall), open **Settings → Setup Wizard → Re-run Setup Wizard**.

## Testing

```bash
npm test
```

226 tests covering workflow builders, preset resolution, smart-select, chat pipeline, Director segment planning, voice store, VLM auto-optimize profiles, and the first-run installer.

## Changelog

Legend: **[Fixed]** bug fix · **[New]** feature or behavior addition · **[Changed]** refactor or behavior change that isn't a bug fix · **[Removed]** feature or API removed.

### Unreleased

- **[Fixed]** AI Director threw *"Select a T2I checkpoint in Settings, or provide an image/video to start from"* even when a T2I preset was configured. The segment planner now checks for a selected T2I preset instead of the legacy raw-checkpoint field.
- **[Fixed]** Extend workflow failed on the first extend with `Invalid image file: (1).png`. The `LoadImage` node for the end frame has been removed and `end_samples` now feeds from the accumulated video's first frame directly — Periodic Reset still steers back to the original project frame, gated by the existing boolean.
- **[Fixed]** App header and debug-console banner displayed *"WAN VIDEO STUDIO"* instead of *AI-HUB*.
- **[New]** Bundled `custom_nodes/` folder shipping every ComfyUI pack the workflows rely on, with install instructions in the README (copy into `ComfyUI/custom_nodes`, then run **Manager → Update All** to reconcile versions).

## License

MIT — see [LICENSE](./LICENSE).

## Acknowledgements

- [ComfyUI](https://github.com/comfyanonymous/ComfyUI) — the generation backend
- [llama.cpp](https://github.com/ggerganov/llama.cpp) + [llama-cpp-python](https://github.com/abetlen/llama-cpp-python) — local VLM inference
- [Whisper.cpp](https://github.com/ggerganov/whisper.cpp) via [pywhispercpp](https://github.com/absadiki/pywhispercpp) — STT
- [Kokoro TTS](https://huggingface.co/hexgrad/Kokoro-82M) and [Piper](https://github.com/rhasspy/piper) — TTS
