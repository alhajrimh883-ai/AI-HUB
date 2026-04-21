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

**Before running the app, move the contents of `custom_nodes/` into your ComfyUI `custom_nodes/` folder.**

**Skip any pack that already exists** on your ComfyUI side — do *not* overwrite it. Your existing version may be newer or contain local changes, and overwriting can break your setup.

### Windows (PowerShell) — skip-if-exists copy

```powershell
$src = "custom_nodes"
$dst = "C:\path\to\ComfyUI\custom_nodes"   # ← change this
Get-ChildItem $src -Directory | Where-Object {
    $_.Name -ne "__pycache__" -and -not (Test-Path (Join-Path $dst $_.Name))
} | ForEach-Object {
    Copy-Item -Recurse -Path $_.FullName -Destination $dst
    Write-Host "Copied: $($_.Name)"
}
```

### macOS / Linux (bash) — skip-if-exists copy

```bash
SRC="custom_nodes"
DST="/path/to/ComfyUI/custom_nodes"   # ← change this
for d in "$SRC"/*/; do
  name=$(basename "$d")
  [ "$name" = "__pycache__" ] && continue
  if [ -e "$DST/$name" ]; then
    echo "Skip (already exists): $name"
  else
    cp -r "$d" "$DST/" && echo "Copied: $name"
  fi
done
```

### Manual (drag-and-drop)

Open `custom_nodes/` in one window and your `ComfyUI/custom_nodes/` in another, then drag the subfolders over. When Windows/macOS asks to merge or replace an existing folder, **choose Skip / Don't replace**.

After copying, start ComfyUI once so it installs each pack's Python dependencies, then come back and launch AI-HUB.

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
                    (copy into ComfyUI/custom_nodes — skip folders that already exist)
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

## License

MIT — see [LICENSE](./LICENSE).

## Acknowledgements

- [ComfyUI](https://github.com/comfyanonymous/ComfyUI) — the generation backend
- [llama.cpp](https://github.com/ggerganov/llama.cpp) + [llama-cpp-python](https://github.com/abetlen/llama-cpp-python) — local VLM inference
- [Whisper.cpp](https://github.com/ggerganov/whisper.cpp) via [pywhispercpp](https://github.com/absadiki/pywhispercpp) — STT
- [Kokoro TTS](https://huggingface.co/hexgrad/Kokoro-82M) and [Piper](https://github.com/rhasspy/piper) — TTS
