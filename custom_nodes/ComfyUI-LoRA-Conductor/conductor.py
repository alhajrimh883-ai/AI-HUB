"""
LoRA Conductor v6 — The model uses the LoRA, not the other way around.

Core insight: LoRAs are trained on image-caption pairs. The training
metadata (ss_tag_frequency) contains the ground truth of what each
LoRA learned. We read this, match against the prompt, and compute
a budget-allocated strength for each LoRA.

No delta computation. No 40-second waits. Just metadata + math.
Runs in under a second for any number of LoRAs.
"""

import torch
import json
import time
import folder_paths
import comfy.sd
import comfy.utils


# Maximum dynamic slots (JS shows 1 by default, button adds more)
MAX_SLOTS = 20


def _read_training_tags(filepath):
    """
    Read training tags from LoRA safetensors metadata.

    Returns: dict of {tag: count} or {} if not available.
    Also tries trigger words as fallback.
    """
    tags = {}

    try:
        from safetensors import safe_open
        with safe_open(filepath, framework="pt", device="cpu") as f:
            metadata = f.metadata() or {}
    except Exception:
        return tags

    # Primary: ss_tag_frequency — full training vocabulary with counts
    raw_freq = metadata.get("ss_tag_frequency", "")
    if raw_freq and len(raw_freq) > 2:
        try:
            freq_data = json.loads(raw_freq)
            for subset_name, subset_tags in freq_data.items():
                if isinstance(subset_tags, dict):
                    for tag, count in subset_tags.items():
                        clean_tag = tag.strip().lower()
                        if len(clean_tag) > 1:
                            tags[clean_tag] = tags.get(clean_tag, 0) + int(count)
        except Exception:
            pass

    # Fallback: trigger words / activation text
    if not tags:
        for key in ["ss_trigger_words", "trigger_words", "activation_text",
                     "modelspec.trigger_phrase"]:
            val = metadata.get(key, "").strip()
            if val and len(val) > 1:
                for word in val.replace(",", " ").split():
                    w = word.strip().lower()
                    if len(w) > 1:
                        tags[w] = 100  # Arbitrary weight for trigger words
                break

    return tags


def _compute_prompt_match(prompt, training_tags):
    """
    Compute how well a prompt matches a LoRA's training data.

    Returns a confidence score 0.0 - 1.0 based on:
    - How many training tags appear in the prompt
    - How frequently those tags were trained on (higher count = more reliable)
    - What fraction of the prompt is covered by training tags

    A LoRA with no metadata gets a default score of 0.5 (unknown = moderate).
    """
    if not training_tags:
        return 0.5  # No metadata — can't judge, use moderate default

    if not prompt or not prompt.strip():
        return 0.5  # No prompt — can't match

    prompt_lower = prompt.lower()
    prompt_words = set(w.strip() for w in prompt_lower.replace(",", " ").split() if len(w.strip()) > 1)

    total_training_weight = sum(training_tags.values())
    matched_weight = 0
    matched_tags = []

    for tag, count in training_tags.items():
        # Check if tag appears in prompt (support multi-word tags)
        if tag in prompt_lower:
            matched_weight += count
            matched_tags.append((tag, count))
        else:
            # Check individual words of the tag
            tag_words = set(tag.split())
            if tag_words and tag_words.issubset(prompt_words):
                matched_weight += count * 0.7  # Partial credit
                matched_tags.append((tag, count))

    if total_training_weight == 0:
        return 0.5

    # Score components:
    # 1. Training coverage: what % of training data is matched
    training_coverage = matched_weight / total_training_weight

    # 2. Prompt coverage: what % of prompt words are in training data
    all_tag_words = set()
    for tag in training_tags:
        all_tag_words.update(tag.split())
    prompt_coverage = len(prompt_words & all_tag_words) / max(len(prompt_words), 1)

    # Combined score — training coverage matters more
    score = 0.7 * training_coverage + 0.3 * prompt_coverage

    # Clamp and apply curve — small matches should still give some credit
    score = min(1.0, score * 2.0)  # Scale up since exact coverage is rare
    score = max(0.05, score)

    return score


def _allocate_budget(scores, total_budget, min_strength, max_strength):
    """
    Allocate a total strength budget across LoRAs based on their match scores.

    Ensures the total applied strength doesn't overwhelm the base model
    regardless of how many LoRAs are loaded.

    Returns: list of strength values, one per LoRA.
    """
    if not scores:
        return []

    # Filter to non-trivial scores
    total_score = sum(scores)

    if total_score < 1e-6:
        # No matches at all — give everyone min_strength
        return [min_strength] * len(scores)

    # Proportional allocation
    strengths = []
    for score in scores:
        # Each LoRA gets a share of the budget proportional to its score
        share = (score / total_score) * total_budget
        # Clamp to min/max
        strength = max(min_strength, min(max_strength, share))
        strengths.append(round(strength, 3))

    return strengths


class LoRAConductor:
    """
    Intelligent LoRA loader with automatic prompt-based strength allocation.

    Reads each LoRA's training metadata to know what it was trained on,
    matches that against your prompt, and computes optimal strengths
    using a budget system that prevents LoRA stacking from overwhelming
    the base model.

    No manual trigger words needed. No slow delta computation.
    Just metadata reading + prompt matching. Runs in under a second.
    """

    @classmethod
    def INPUT_TYPES(cls):
        lora_list = ["None"] + folder_paths.get_filename_list("loras")

        required = {
            "model": ("MODEL",),
            "clip": ("CLIP",),
            "prompt": ("STRING", {
                "default": "",
                "multiline": True,
                "tooltip": "Your generation prompt. Used for automatic strength allocation."
            }),
            "total_budget": ("FLOAT", {
                "default": 2.5, "min": 0.5, "max": 10.0, "step": 0.1,
                "tooltip": "Total strength budget shared across all LoRAs. Higher = more LoRA influence overall."
            }),
            "min_strength": ("FLOAT", {
                "default": 0.0, "min": 0.0, "max": 1.0, "step": 0.05,
                "tooltip": "Minimum strength for any LoRA (0 = fully disable non-matching LoRAs)."
            }),
            "max_strength": ("FLOAT", {
                "default": 1.0, "min": 0.1, "max": 2.0, "step": 0.05,
                "tooltip": "Maximum strength for any single LoRA."
            }),
            "auto_routing": ("BOOLEAN", {
                "default": True,
                "tooltip": "Auto-compute strengths from metadata. Off = all LoRAs get equal share of budget."
            }),
            # First LoRA slot always visible
            "lora_1": (lora_list, {"default": "None"}),
        }

        # Slots 2-20 are optional (JS button adds them)
        optional = {}
        for i in range(2, MAX_SLOTS + 1):
            optional[f"lora_{i}"] = (lora_list, {"default": "None"})

        return {"required": required, "optional": optional}

    RETURN_TYPES = ("MODEL", "CLIP", "STRING",)
    RETURN_NAMES = ("model", "clip", "routing_info",)
    FUNCTION = "execute"
    CATEGORY = "LoRA Conductor"
    DESCRIPTION = "Smart LoRA loader: reads training metadata, auto-computes strengths from prompt. Add LoRAs with the + button."

    def execute(self, model, clip, prompt, total_budget, min_strength,
                max_strength, auto_routing, lora_1="None", **kwargs):

        t0 = time.time()
        m = model.clone()
        c = clip.clone()

        # Collect all active LoRA slots
        filenames = []
        if lora_1 and lora_1 != "None":
            filenames.append(lora_1)
        for i in range(2, MAX_SLOTS + 1):
            name = kwargs.get(f"lora_{i}", "None")
            if name and name != "None":
                filenames.append(name)

        if not filenames:
            return (m, c, "No LoRAs selected")

        # Step 1: Read metadata for all LoRAs (fast — just file headers)
        lora_info = []
        for fname in filenames:
            lora_path = folder_paths.get_full_path("loras", fname)
            if lora_path is None:
                print(f"[Conductor] '{fname}' not found, skipping.")
                continue

            tags = _read_training_tags(lora_path)
            short = fname.rsplit("/", 1)[-1].rsplit("\\", 1)[-1]  # filename only
            if len(short) > 35:
                short = short[:32] + "..."

            lora_info.append({
                "filename": fname,
                "short": short,
                "path": lora_path,
                "tags": tags,
                "n_tags": len(tags),
                "has_meta": len(tags) > 0,
            })

        if not lora_info:
            return (m, c, "No valid LoRAs found")

        # Step 2: Compute match scores
        if auto_routing and prompt.strip():
            scores = [_compute_prompt_match(prompt, li["tags"]) for li in lora_info]
        else:
            scores = [1.0] * len(lora_info)

        # Step 3: Allocate budget
        strengths = _allocate_budget(scores, total_budget, min_strength, max_strength)

        # Step 4: Build info report and load LoRAs
        info_lines = ["=== LoRA Conductor ==="]
        loaded = 0

        for i, (li, score, strength) in enumerate(zip(lora_info, scores, strengths)):
            # Info bar
            bar_len = int(min(strength, 1.0) * 20)
            bar = "\u2588" * bar_len + "\u2591" * (20 - bar_len)
            meta_tag = f"{li['n_tags']} tags" if li["has_meta"] else "no meta"
            match_str = f"match:{score:.0%}" if auto_routing else ""

            info_lines.append(
                f"  {li['short']:35s} [{bar}] {strength:.2f} ({meta_tag}) {match_str}"
            )

            if strength < 0.001:
                info_lines[-1] += "  [OFF]"
                continue

            # Load and apply LoRA
            try:
                lora_sd = comfy.utils.load_torch_file(li["path"], safe_load=True)
                m, c = comfy.sd.load_lora_for_models(
                    m, c, lora_sd,
                    strength_model=strength,
                    strength_clip=strength
                )
                loaded += 1
                del lora_sd
            except Exception as e:
                print(f"[Conductor] Error loading '{li['filename']}': {e}")
                info_lines[-1] += f"  [ERROR]"

        elapsed = time.time() - t0
        budget_used = sum(s for s in strengths if s >= 0.001)
        info_lines.append(f"\n  Budget: {budget_used:.2f} / {total_budget:.1f} used | "
                          f"{loaded} LoRAs loaded in {elapsed:.1f}s")

        routing_info = "\n".join(info_lines)
        print(routing_info)

        return (m, c, routing_info)
