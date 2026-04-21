# ComfyUI-LoRA-Conductor

**The model uses the LoRA — not the other way around.**

One node that replaces Power Lora Loader with intelligent, prompt-aware LoRA management. Reads each LoRA's training metadata to know what it learned, matches that against your prompt, and allocates a strength budget so stacking 10+ LoRAs doesn't destroy the base model.

No slow delta computation. No manual trigger words. Runs in under a second.

## Install

```bash
cd ComfyUI/custom_nodes/
git clone https://github.com/YOUR_USERNAME/ComfyUI-LoRA-Conductor.git
# Restart ComfyUI
```

## How it works

1. **Reads training metadata** from each LoRA's safetensors file header (`ss_tag_frequency`, `trigger_words`, etc.). This tells us exactly what each LoRA was trained on.

2. **Matches tags against your prompt.** If a LoRA was trained on "sarah connor, leather jacket" and your prompt says "sarah connor in a garden" — it knows "sarah connor" is a strong match.

3. **Allocates a strength budget.** Instead of each LoRA fighting for dominance at strength 1.0, a total budget (default 2.5) is shared proportionally. High-match LoRAs get more, low-match get less or zero.

4. **Loads LoRAs** with computed strengths using ComfyUI's native `load_lora_for_models`. Zero custom patching, fully VRAM-safe.

## Usage

1. Add the **LoRA Conductor** node
2. Connect your checkpoint model and CLIP
3. Select LoRAs from the dropdown (right-click → **Add LoRA** for more slots)
4. Type your prompt
5. Connect model + clip outputs to your KSampler

That's it. The node handles everything else automatically.

## Parameters

| Parameter | Default | What it does |
|-----------|---------|--------------|
| total_budget | 2.5 | Total strength shared across all LoRAs. Higher = more LoRA influence overall. |
| min_strength | 0.0 | Floor for any LoRA. Set to 0.1 if you never want a LoRA fully disabled. |
| max_strength | 1.0 | Cap for any single LoRA. Raise to 1.5 for very subtle LoRAs. |
| auto_routing | true | Enable prompt-based routing. Off = equal budget split. |

## Budget examples

**3 LoRAs, budget 2.5, prompt "sarah connor in cyberpunk city":**
```
sarah_connor.safetensors      [████████████████░░░░] 0.95  (match:92%)
cyberpunk_style.safetensors   [██████████████░░░░░░] 0.85  (match:78%)
yoga_poses.safetensors        [░░░░░░░░░░░░░░░░░░░░] 0.00  (match:3%)   [OFF]
```

**10 LoRAs, budget 3.0, prompt "anime girl with red hair, watercolor":**
```
anime_girl.safetensors        [████████████████░░░░] 0.80  (match:88%)
red_hair.safetensors          [██████████████░░░░░░] 0.70  (match:75%)
watercolor.safetensors        [████████████░░░░░░░░] 0.65  (match:70%)
detail_enhancer.safetensors   [██████░░░░░░░░░░░░░░] 0.35  (no meta)
... 6 more at 0.00 [OFF]
```

## LoRAs without metadata

LoRAs that don't have training metadata (older files, manually trained) get a default score of 0.5 — moderate confidence. They receive a proportional share of the budget but aren't boosted or suppressed. You can adjust `min_strength` to ensure they always get something.

## License

MIT
