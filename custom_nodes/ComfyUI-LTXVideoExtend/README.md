# ComfyUI-LTXVideoExtend

Custom ComfyUI nodes for extending videos using **LTX 2.3**'s latent-space inpainting mechanism. Turn any video (with or without audio) into a longer one by generating new content that seamlessly continues from the original.

## Features

- **Video + Audio continuation** — Encode both video and audio, extend both together
- **Video-only mode** — Works without audio when you just need visual extension
- **Looping / chaining** — Chain multiple extensions for arbitrarily long videos
- **Overlap blending** — Smooth transitions between segments with configurable blend curves
- **Auto frame-count snapping** — Handles LTX's `8k+1` frame constraint automatically
- **Resolution validation** — Auto-snaps to divisible-by-32 dimensions

## Nodes

### 1. LTX Video Extend From Reference
The main workhorse. Takes your reference video frames (and optional audio), encodes them to LTX latent space, and creates a masked latent ready for sampling.

**Inputs:**
| Input | Type | Description |
|-------|------|-------------|
| `video_frames` | IMAGE | Your reference video frames |
| `vae` | VAE | LTX 2.3 Video VAE |
| `extension_seconds` | FLOAT | How many seconds to extend |
| `fps` | FLOAT | Frame rate (match your video) |
| `overlap_frames` | INT | Frames for soft overlap blending |
| `blend_mode` | ENUM | linear / cosine / none |
| `width` / `height` | INT | Output size (0 = auto from input) |
| `audio` | AUDIO (opt) | Reference audio to continue from |
| `audio_vae` | VAE (opt) | LTX Audio VAE |

**Outputs:**
| Output | Type | Description |
|--------|------|-------------|
| `latent` | LATENT | Masked latent ready for KSampler |
| `total_frames` | INT | Total pixel frame count |
| `extension_start_frame` | INT | Where new content begins |
| `fps` | FLOAT | Pass-through for downstream nodes |

### 2. LTX Video Chain Extension
For generating long videos iteratively. Takes decoded frames from a previous generation and prepares the next segment.

### 3. LTX Video Overlap Blend
Post-decode blending. Takes two decoded video segments and blends them at the overlap boundary with configurable curves (linear, cosine, sigmoid).

### 4. LTX Video Frame Info
Utility node that calculates valid frame counts and displays planning information. Connect your video to sanity-check everything before sampling.

### 5. LTX Video Extract Tail Frames
Helper that extracts the last N frames from a video for chaining context, with optional 8k+1 snapping.

---

## Installation

```bash
cd ComfyUI/custom_nodes
git clone https://github.com/YOUR_USERNAME/ComfyUI-LTXVideoExtend.git
# Restart ComfyUI
```

Or manually copy the folder to `ComfyUI/custom_nodes/ComfyUI-LTXVideoExtend/`.

**Requirements:** Only standard PyTorch (ships with ComfyUI). No extra dependencies.

---

## Required Models

You need the standard LTX 2.3 model stack:

```
ComfyUI/
└── models/
    ├── checkpoints/
    │   └── ltx-2.3-22b-dev-fp8.safetensors     (or bf16 variant)
    ├── vae/
    │   ├── LTX23_video_vae_bf16.safetensors
    │   └── LTX23_audio_vae_bf16.safetensors     (for audio mode)
    ├── loras/
    │   └── ltx-2.3-22b-distilled-lora-384.safetensors
    ├── text_encoders/
    │   └── gemma_3_12B_it_fp8_scaled.safetensors
    └── latent_upscale_models/
        └── ltx-2.3-spatial-upscaler-x2-1.0.safetensors
```

---

## Workflow Examples

### Workflow A: Simple Video Extension (Video Only)

```
┌─────────────┐    ┌──────────────────────────┐    ┌──────────────┐
│ Load Video   │───▶│ LTX Video Extend From    │───▶│ KSampler     │
│ (VHS)        │    │ Reference                │    │ Advanced     │
└─────────────┘    │                          │    └──────┬───────┘
                   │  extension_seconds: 5.0  │           │
┌─────────────┐    │  fps: 24                 │    ┌──────▼───────┐
│ Load VAE     │───▶│  overlap_frames: 8       │    │ VAE Decode   │
│ (Video VAE)  │    │  blend_mode: cosine      │    └──────┬───────┘
└─────────────┘    └──────────────────────────┘           │
                                                   ┌──────▼───────┐
┌─────────────┐    ┌──────────────────────────┐    │ VHS Video    │
│ Gemma Text   │───▶│ LTXVConditioning         │───▶│ Combine      │
│ Encode       │    └──────────────────────────┘    └──────────────┘
└─────────────┘
```

**Step by step:**
1. **Load Video** — Use VHS Video Loader to load your reference video
2. **Load VAE** — Load `LTX23_video_vae_bf16.safetensors`
3. **Load model** — Load LTX 2.3 checkpoint + distilled LoRA
4. **LTX Video Extend From Reference** — Connect video frames + VAE, set extension_seconds
5. **Text prompt** — Describe what should happen in the extension
6. **KSampler** — Sample the masked latent (use LTXVScheduler)
7. **VAE Decode** — Decode the result
8. **Save** — Combine into video file


### Workflow B: Video + Audio Extension

Same as Workflow A, but additionally:
- Load `LTX23_audio_vae_bf16.safetensors` as the Audio VAE
- Connect your audio source to the `audio` input
- Connect the Audio VAE to the `audio_vae` input
- After sampling, decode audio separately with the Audio VAE
- Use VHS Video Combine to mux video + audio


### Workflow C: Chained Long Video (3+ segments)

```
=== SEGMENT 1 (Initial) ===

Load Image ──▶ LTX Video Extend From Reference ──▶ KSampler ──▶ VAE Decode
                    │                                               │
                    ▼                                               ▼
              (latent out)                                   (frames_1)
                                                                    │
=== SEGMENT 2 ===                                                   │
                                                                    ▼
frames_1 ──▶ LTX Video Chain Extension ──▶ KSampler ──▶ VAE Decode
                  │                                          │
                  │  context_frames: 33                      ▼
                  │  extension_seconds: 5.0            (frames_2)
                  │  overlap_frames: 8                       │
                  ▼                                          │
                                                             ▼
=== SEGMENT 3 ===                                            │
                                                             ▼
frames_2 ──▶ LTX Video Chain Extension ──▶ KSampler ──▶ VAE Decode
                                                             │
                                                             ▼
                                                       (frames_3)

=== FINAL STITCH ===

frames_1 ──▶ LTX Video Overlap Blend ──▶ LTX Video Overlap Blend ──▶ Save
frames_2 ──────────┘                           │
frames_3 ──────────────────────────────────────┘
```

**Key settings for chaining:**
- `context_frames: 33` — Use ~33 frames (≈1.4s at 24fps) as overlap context
- Use **different seeds** for each segment (critical!)
- Use **different prompts** per segment for story progression
- Keep `overlap_frames: 8` and `blend_mode: cosine` for smooth transitions


### Workflow D: Using with Existing LTX Nodes (LTXVImgToVideoInplace)

If you prefer to use the built-in `LTXVImgToVideoInplace` node instead of our
custom encoding, you can use just the utility nodes:

1. Use **LTX Video Frame Info** to plan your frame counts
2. Use **LTX Video Extract Tail Frames** to get context for chaining
3. Use **LTX Video Overlap Blend** to stitch decoded segments

---

## Technical Details

### How the Extension Mechanism Works

1. **Encode** — Your reference video is VAE-encoded to latent space
2. **Pad** — Empty latent frames (gray, value 0.5) are appended for the extension region
3. **Mask** — A temporal noise mask is built:
   - `0.0` for original frames (preserved during sampling)
   - `1.0` for extension frames (fully denoised/generated)
   - `0.0 → 1.0` gradient in the overlap region (soft transition)
4. **Sample** — KSampler denoises only the masked region, using the original frames as context
5. **Decode** — VAE decodes the full latent (original + generated) back to pixels

### The 8k+1 Rule

LTX 2.3 requires total pixel frame counts of the form `8k + 1`:
- Valid: 1, 9, 17, 25, 33, 41, 49, 57, 65, 73, 81, 89, 97, 105, ...
- The nodes automatically snap to the nearest valid count upward

### Overlap Blending

The overlap region uses a soft mask that transitions from 0 (keep original) to 1 (generate new):

- **Linear**: `mask = t` — Simple straight ramp
- **Cosine**: `mask = 0.5 * (1 - cos(π * t))` — Smooth S-curve (recommended)
- **None**: Hard cut at the boundary

### Audio Handling

When audio is provided:
- The Audio VAE encodes the reference audio to latent space
- Audio latent is attached to the output for joint denoising
- LTX 2.3's bidirectional cross-modal attention handles sync
- After sampling, decode audio with the Audio VAE separately

---

## Tips

1. **Use different seeds per segment** when chaining — this is critical for natural motion
2. **Keep context_frames around 33** (≈1.4s) — enough for continuity without wasting compute
3. **Start with cosine blend mode** — it produces the smoothest transitions
4. **Use descriptive prompts** for each segment — describe the action you want to see
5. **Try the LTX Video Frame Info node first** — validate your frame counts before sampling
6. **For very long videos (60s+)**, expect gradual drift — LTX doesn't have SVI's error correction
7. **Resolution matters** — higher resolution generally produces better motion quality

## Known Limitations

- **No SVI-style error correction** — Long sequences will gradually drift without LoRA-based correction
- **Audio sync** may be imperfect across segment boundaries
- **VRAM hungry** — The full LTX 2.3 22B model needs significant VRAM especially with long contexts
- **Frame count constraints** — The 8k+1 rule means you can't get exact durations; the nodes snap to the nearest valid count

## License

MIT License — use freely in personal and commercial projects.

## Credits

- [Lightricks](https://github.com/Lightricks/LTX-2) — LTX 2.3 model and official ComfyUI nodes
- [Kijai](https://github.com/kijai/ComfyUI-KJNodes) — Inspiration from KJNodes LTX AudioVideo masking
- [RuneXX](https://huggingface.co/Kijai/LTX2.3_comfy/discussions/32) — Extend Any Video workflow concept
- [SVI / vita-epfl](https://github.com/vita-epfl/Stable-Video-Infinity) — Conceptual inspiration for chaining architecture
