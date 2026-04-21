"""
RefAttnExtend — Prepares overlap frames for video extension.
Takes the previous segment's output and creates the overlap context
for the next segment's generation.

Wire this between segments:
  KSampler(seg1) → RefAttnExtend → KSampler(seg2) → RefAttnExtend → ...

The ref_features input is the SAME FeatureBank for all segments —
this is what prevents identity drift.
"""

import torch
import logging

logger = logging.getLogger("RefAttn")


class RefAttnExtend:
    """Prepare overlap context for video extension."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "previous_latent": ("LATENT",),
                "vae": ("VAE",),
                "overlap_frames": ("INT", {
                    "default": 8,
                    "min": 2,
                    "max": 16,
                    "step": 1,
                    "tooltip": "Number of frames to carry over from previous segment. "
                               "More = smoother transition but less new content. "
                               "8 is a good default for 33-frame segments.",
                }),
                "overlap_denoise": ("FLOAT", {
                    "default": 0.3,
                    "min": 0.0,
                    "max": 1.0,
                    "step": 0.05,
                    "display": "slider",
                    "tooltip": "How much freedom the overlap region gets. "
                               "0.0 = locked (stiff transitions). "
                               "0.3 = slight adjustment (recommended). "
                               "0.7+ = loose (may cause flicker).",
                }),
                "new_frames": ("INT", {
                    "default": 25,
                    "min": 8,
                    "max": 81,
                    "step": 1,
                    "tooltip": "Number of NEW frames to generate (on top of overlap). "
                               "Total segment length = overlap_frames + new_frames.",
                }),
            },
        }

    RETURN_TYPES = ("LATENT", "INT",)
    RETURN_NAMES = ("latent", "total_frames",)
    FUNCTION = "prepare_extension"
    CATEGORY = "RefAttn"

    def prepare_extension(
        self,
        previous_latent,
        vae,
        overlap_frames=8,
        overlap_denoise=0.3,
        new_frames=25,
    ):
        # ComfyUI LATENT is {"samples": tensor}
        prev_samples = previous_latent["samples"]

        # Extract last N frames from the latent
        # Latent shape: [B, C, T, H, W]
        total_prev_frames = prev_samples.shape[2]

        if overlap_frames >= total_prev_frames:
            logger.warning(
                f"overlap_frames ({overlap_frames}) >= total previous frames "
                f"({total_prev_frames}), clamping to {total_prev_frames - 1}"
            )
            overlap_frames = total_prev_frames - 1

        overlap_latents = prev_samples[:, :, -overlap_frames:, :, :]

        # Add partial noise to overlap region
        # This gives the model some freedom to adjust while keeping context
        if overlap_denoise > 0:
            noise = torch.randn_like(overlap_latents)
            # Simple noise mixing: (1-d)*signal + d*noise
            noisy_overlap = (1.0 - overlap_denoise) * overlap_latents + overlap_denoise * noise
        else:
            noisy_overlap = overlap_latents

        # Create fresh noise for the new frames
        new_noise = torch.randn(
            prev_samples.shape[0],  # batch
            prev_samples.shape[1],  # channels
            new_frames,             # new temporal frames
            prev_samples.shape[3],  # height
            prev_samples.shape[4],  # width
            device=prev_samples.device,
            dtype=prev_samples.dtype,
        )

        # Concatenate: overlap (partially noised) + new (fully noised)
        combined_latent = torch.cat([noisy_overlap, new_noise], dim=2)

        total_frames = overlap_frames + new_frames

        logger.info(
            f"Extension prepared: {overlap_frames} overlap + {new_frames} new = "
            f"{total_frames} total frames, denoise={overlap_denoise}"
        )

        return ({"samples": combined_latent}, total_frames,)
