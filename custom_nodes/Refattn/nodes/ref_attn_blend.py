"""
RefAttnBlendSegments — Blends/stitches decoded video segments together.
Handles the overlap blending at pixel level after VAE decoding.

Use this AFTER decoding each segment through the VAE.
Connect all decoded segments and it produces the final stitched video.
"""

import torch
import logging

logger = logging.getLogger("RefAttn")


class RefAttnBlendSegments:
    """Blend decoded video segments into a single video."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "segment_a": ("IMAGE",),
                "segment_b": ("IMAGE",),
                "overlap_frames": ("INT", {
                    "default": 8,
                    "min": 1,
                    "max": 16,
                    "step": 1,
                    "tooltip": "Must match the overlap_frames used in RefAttnExtend.",
                }),
                "blend_mode": (["linear", "sigmoid"], {
                    "default": "sigmoid",
                    "tooltip": "linear: simple crossfade. "
                               "sigmoid: smoother S-curve transition (recommended).",
                }),
            },
            "optional": {
                "previous_blend": ("IMAGE", {
                    "tooltip": "Chain multiple blends: connect output of a previous "
                               "RefAttnBlendSegments here to keep adding segments.",
                }),
            },
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("video",)
    FUNCTION = "blend"
    CATEGORY = "RefAttn"

    def blend(
        self,
        segment_a,
        segment_b,
        overlap_frames=8,
        blend_mode="sigmoid",
        previous_blend=None,
    ):
        # If previous_blend is provided, use it as segment_a instead
        # This allows chaining: blend(blend(A, B), C)
        if previous_blend is not None:
            segment_a = previous_blend

        # ComfyUI IMAGE format: [T, H, W, C] (batch of frames)
        device = segment_a.device

        T_a = segment_a.shape[0]
        T_b = segment_b.shape[0]

        if overlap_frames >= min(T_a, T_b):
            logger.warning(
                f"overlap_frames ({overlap_frames}) too large for segments "
                f"({T_a}, {T_b}), clamping"
            )
            overlap_frames = min(T_a, T_b) - 1

        # Extract overlap regions
        overlap_a = segment_a[-overlap_frames:]   # [overlap, H, W, C]
        overlap_b = segment_b[:overlap_frames]     # [overlap, H, W, C]

        # Create blend weights
        if blend_mode == "linear":
            weights = torch.linspace(1.0, 0.0, overlap_frames, device=device)
        elif blend_mode == "sigmoid":
            x = torch.linspace(6.0, -6.0, overlap_frames, device=device)
            weights = torch.sigmoid(x)
        else:
            weights = torch.linspace(1.0, 0.0, overlap_frames, device=device)

        # Reshape for broadcasting: [T, 1, 1, 1]
        weights = weights.view(-1, 1, 1, 1)

        # Blend the overlap region
        blended = overlap_a * weights + overlap_b * (1 - weights)

        # Stitch
        result = torch.cat([
            segment_a[:-overlap_frames],  # A without overlap
            blended,                       # Blended region
            segment_b[overlap_frames:],    # B without overlap
        ], dim=0)

        logger.info(
            f"Blended: {T_a} + {T_b} frames → {result.shape[0]} frames "
            f"(overlap={overlap_frames}, mode={blend_mode})"
        )

        return (result,)
