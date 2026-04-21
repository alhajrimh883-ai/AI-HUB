"""
Attention patcher for RefAttn — Wan 2.2 compatible.
Lean version: patches only middle layers, uses fp16, minimal memory.
"""

import torch
import torch.nn.functional as F
import logging
from typing import Callable

logger = logging.getLogger("RefAttn")

# Only patch these layers (middle layers where identity lives)
# Early layers = structure, late layers = detail, middle = identity
DEFAULT_LAYER_RANGE = (10, 30)


class RefAttnPatcher:

    def __init__(self):
        self._patched = False
        self._hook_handles = []

    def patch(self, model_patcher, feature_bank, scheduler_fn: Callable, total_steps: int = 30):
        if not feature_bank.has_kv():
            logger.warning("Feature bank has no K/V cache, skipping patch")
            return

        # Map layer names to block indices
        block_kv = {}
        for layer_name, kv in feature_bank.reference_kv.items():
            parts = layer_name.split(".")
            for i, p in enumerate(parts):
                if p == "blocks" and i + 1 < len(parts):
                    try:
                        block_kv[int(parts[i + 1])] = kv
                    except ValueError:
                        pass

        if not block_kv:
            return

        # Only use middle layers
        lo, hi = DEFAULT_LAYER_RANGE
        active_blocks = {idx: kv for idx, kv in block_kv.items() if lo <= idx < hi}
        logger.info(f"Active blocks: {len(active_blocks)}/{len(block_kv)} (range {lo}-{hi})")

        peak_weight = max(scheduler_fn(s, total_steps) for s in range(total_steps))
        logger.info(f"Injection weight: {peak_weight:.3f}")

        # Pre-compute mean ref V per layer (tiny: [1, 1, 5120] per layer)
        # Instead of full SDPA, we use a lightweight "mean V bias" approach
        # This uses ~0 extra memory and ~0 extra compute
        ref_bias = {}
        for block_idx, kv in active_blocks.items():
            # Mean pool ref V across sequence dim → global identity vector
            v_mean = kv["v"].mean(dim=1, keepdim=True)  # [1, 1, 5120]
            ref_bias[block_idx] = {
                "v_mean": v_mean.half(),  # fp16 to save memory
                "device_ready": False,
            }

        # Free the full K/V cache — we only need the mean V
        # This saves ~3GB VRAM
        feature_bank.reference_kv = {}
        logger.info("Released full K/V cache, using mean-V bias (saves ~3GB)")

        def attn1_output_patch(out, extra_options):
            block_idx = extra_options.get("block_index", -1)

            if block_idx not in ref_bias:
                return out

            rd = ref_bias[block_idx]

            if not rd["device_ready"]:
                rd["v_mean"] = rd["v_mean"].to(device=out.device, dtype=out.dtype)
                rd["device_ready"] = True
                logger.info(f"Block {block_idx}: bias shape {rd['v_mean'].shape}, out shape {out.shape}")

            # Add identity bias: each token gets nudged toward the mean ref V
            # This is like cross-attention with uniform weights
            out = out + peak_weight * rd["v_mean"].expand_as(out)

            return out

        model_patcher.set_model_attn1_output_patch(attn1_output_patch)
        self._patched = True
        logger.info(f"Patched {len(ref_bias)} middle layers (mean-V bias, ~0 overhead)")

    def unpatch(self, dit_model=None):
        for h in self._hook_handles:
            h.remove()
        self._hook_handles = []
        self._patched = False

    def reset_step_counters(self, dit_model=None):
        pass
