# ComfyUI-RefAttn

**Reference Attention for Wan 2.2** — Identity preservation with full prompt following.

RefAttn injects identity features from a reference image into Wan 2.2's self-attention layers while leaving text cross-attention completely untouched. This gives you the identity consistency of SVI Pro with the prompt following of base Wan 2.2.

## How it works

1. **Extract** — InsightFace extracts face geometry, CLIP extracts appearance, and a reference forward pass caches self-attention K/V from every DiT layer
2. **Inject** — During generation, reference K/V is concatenated into each self-attention layer at a strength controlled by the timestep scheduler
3. **Extend** — For video extension, the feature bank (extracted once) anchors identity across all segments, preventing drift

Text cross-attention is never modified — the prompt drives scene composition and motion exactly as it does in base Wan 2.2.

## Installation

```bash
cd ComfyUI/custom_nodes
git clone https://github.com/YOUR_USERNAME/ComfyUI-RefAttn.git
cd ComfyUI-RefAttn
pip install -r requirements.txt
```

## Nodes

### RefAttn Extract Features
Extracts identity features from a reference image. Run once per reference.

| Input | Description |
|-------|-------------|
| reference_image | The identity source image (face clearly visible) |
| model | Wan 2.2 model |
| vae | Wan 2.2 VAE |
| face_weight | Balance between face geometry (high) and appearance (low) |
| extraction_timestep | Noise level for reference pass (~500 recommended) |

**Output:** `ref_features` (REF_FEATURES) — reuse across all segments

### RefAttn Timestep Scheduler
Configures when and how much identity gets injected.

| Input | Description |
|-------|-------------|
| mode | Schedule curve: balanced, identity_heavy, prompt_heavy, front_loaded, constant |
| strength | Global injection multiplier (0.0–1.0) |
| start_percent | When to begin injection (skip early steps for better composition) |
| end_percent | When to stop injection (let final steps refine naturally) |
| total_steps | Must match your KSampler steps |
| segment_index | Current segment number (for drift compensation) |

### RefAttn Apply to Model
Patches the model's self-attention. Connect between model loader and KSampler.

### RefAttn Extend Video
Prepares overlap frames for the next segment during extension.

### RefAttn Blend Segments
Stitches decoded video segments with smooth blending.

## Basic workflow

```
[Load Wan 2.2 Model] → [RefAttn Apply] → [KSampler] → [VAE Decode] → [Save Video]
                              ↑
[Load Image] → [RefAttn Extract] → ref_features
                              ↑
              [RefAttn Scheduler] → schedule
```

## Extension workflow

```
Segment 1:
  [RefAttn Apply] → [KSampler] → [RefAttn Extend] → latent
                                                        ↓
Segment 2:                                          [KSampler] → [RefAttn Extend] → latent
                                                                                        ↓
Segment 3:                                                                          [KSampler]

All segments share the SAME ref_features from [RefAttn Extract]

After VAE decode:
  [Seg1 frames] → [RefAttn Blend] → [Seg2 frames] → [RefAttn Blend] → final video
```

## IMPORTANT: First-run adaptation

The attention layer detection in `core/feature_extraction.py` needs to match your specific Wan 2.2 checkpoint structure. On first run, if you see "No self-attention layers found", run the inspection script:

```bash
python inspect_model.py --model /path/to/your/wan22_checkpoint.safetensors
```

This prints all module names and types. Update `_is_self_attention()` in `core/feature_extraction.py` to match the patterns you see.

## Recommended starting settings

| Setting | Value | Notes |
|---------|-------|-------|
| mode | balanced | Best for general use |
| strength | 0.5–0.7 | Start at 0.5, increase if identity is weak |
| start_percent | 0.05 | Let first 5% be prompt-only |
| end_percent | 0.95 | Let last 5% refine |
| face_weight | 0.6 | Increase for face-focused, decrease for full-body |
| overlap_frames | 8 | For 33-frame segments |
| overlap_denoise | 0.3 | Higher = smoother but riskier |

## Troubleshooting

**"No face detected"** — The reference image needs a clearly visible face. InsightFace works best with frontal or 3/4 angle faces, minimum ~128px face size.

**Identity too weak** — Increase `strength`, try `identity_heavy` mode, or increase `face_weight`.

**Prompt not following** — Decrease `strength`, try `prompt_heavy` mode, or narrow the `start_percent`/`end_percent` window.

**Flickering at segment boundaries** — Increase `overlap_frames` to 10-12, or try `sigmoid` blend mode.

**Face morphing over many segments** — Enable `drift_compensation: auto` and make sure all segments use the same `ref_features`.
