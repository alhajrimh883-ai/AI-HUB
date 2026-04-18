# AI-HUB — Current App

## Overview
Electron + React + Vite + Tailwind desktop app orchestrating ComfyUI for AI image/video generation. Dark space theme with starfield background.

---

## Tabs

### 1. Studio (T2I Image Generation)
- Manual preset-based generation — user picks preset, mode, resolution
- **Family-aware builder**: detects preset family (SDXL or Qwen) → uses correct workflow
- SDXL: CheckpointLoader, resolution via switch nodes
- Qwen: UNETLoader + CLIPLoader + VAELoader, resolution via direct width/height, shift control
- Mode toggle: Fast / Quality — filters presets
- User LoRA panel, resolution presets, batch generation (1/2/4/6)
- Session system, floating glass prompt bar, clean image grid

#### ImageOverlay (click any image)
- Edit (Qwen Edit), HireFix (Qwen/SDXL), Animate (VLM modes: Off/Guided/Auto)
- Auto-saves I2V to Director projects
- Unified delete, separate prompt states, save/download

### 2. AI Director (Autonomous Video Pipeline)
- Premiere-style layout, 1 min+ without degradation
- Pipeline: Planner > LoRA Scan > T2I > Body Fix > HireFix > I2V > Extend xN > Review
- Clip-based ffmpeg concat (zero re-encoding)
- SVI PRO FLF end-frame control, resume from video/import

### 3. Presets (Sidebar Layout)
```
GENERATION           Content: 2-column grid
  🖼️ Image (N)      + New/Combine buttons
  🎬 Video (N)
  ✏️ Edit (N)
  🔍 HireFix (N)
  🧠 VLM (N)
LORAS
  🔗 Pool (N)       App-wide, linked to presets
  🎬 Director (N)   Wan 2.2 dual H/L, per-segment
SETTINGS
  ⚙️ Options        Required models, video preset toggle
```

#### T2I Families
- **SDXL**: checkpoint, steps/cfg (no shift)
- **Qwen**: unet + clip + vae, steps/cfg/shift

#### Description field on all presets — VLM reads descriptions for smart selection
#### Model Type, Combined Presets, LoRA Pool, Director LoRAs

### 4. Chat (VLM Conversation + AI Tools)
- Session-based chat with local VLM, persisted to disk
- **Image attachment**: paste or 📎 button (label-wrapped for Electron)
- **Thinking tag support**: `<think>`, `<thinking>`, `<reasoning>`, `<thought>`, Gemma 4 `<|channel>thought`
- **Font size control**: slider 8-16px, persisted
- **Collapsible session sidebar**: X to close, 💬 to reopen
- **Context management**: image stripping (last 2), auto-compact at 95%
- **Smart VRAM**: loaded → infer direct, parked → unpark, unloaded → full setup

#### Image Generation Tool
- VLM responds with `<generate>prompt</generate>` when user asks to create an image
- Chat detects tag → triggers Image Agent (separate context)
- Agent: smart select preset + LoRAs → build workflow → queue ComfyUI → capture
- Result: image inline in chat + "Generated with [preset] + [LoRAs]"

### 5. Gallery (3 tabs)
- Generated (packages), Imported (folders), Director (projects with engine badges)

### 6. Settings
- ComfyUI config, VLM setup, notifications

---

## Architecture

### Smart Select Engine (`src/lib/smartSelect.js`)
- VLM decides, app manages (filter by type, batch LoRAs, validate responses)
- Sequential: preset first → LoRAs second (only if linked)
- Separate inference context — never touches chat history
- Used by: Image Agent, Director (future)

### Image Agent (`src/lib/agents/imageAgent.js`)
- Standalone: prompt in → image out
- Smart select → park VLM → build workflow (family-aware) → queue → capture
- Converts pool LoRAs to workflow format
- Returns: { images, preset, loras, reasoning, seed }

### Workflow Builders (`src/lib/studioWorkflow.js`)
- `buildT2I()` — SDXL (checkpoint, switch nodes, LoraLoader)
- `buildQwenT2I()` — Qwen (unet/clip/vae, direct width/height, ModelSamplingAuraFlow, injectLorasSplit)
- `buildHireFix()` — Qwen Edit upscale

### VRAM Management
- Chat: smart check (loaded/parked/unloaded), skip unnecessary work
- Studio: `parkVlmIfLoaded()` before all ComfyUI operations
- Director: `prepareForComfyUI()` before generation steps
- Image Agent: parks VLM after smart select, before ComfyUI queue

### Stores
- **presetStore**: presets (with descriptions), loraPresets, resolvePreset, combinePresets
- **chatStore**: sessions, messages, context mgmt, auto-compact, fontSize
- **directorStore**: pipeline state, templates, timing, Director LoRAs
- **store**: ComfyUI connection, scanned models (checkpoints, loras, clips, vaes, unets)

---

*Last updated: April 17, 2026 — Chat Tools + Qwen T2I + Smart Select*
