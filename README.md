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
