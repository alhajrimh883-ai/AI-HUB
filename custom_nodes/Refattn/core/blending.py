"""
Overlap and blending for video extension.
Handles frame overlap encoding and segment stitching.
"""

import torch
import logging

logger = logging.getLogger("RefAttn")


def encode_overlap_frames(
    vae,
    last_frames: torch.Tensor,
    overlap_count: int,
    noise_scheduler,
    start_timestep: int,
    overlap_denoise: float = 0.3,
) -> torch.Tensor:
    """
    Encode the last N frames of a segment as overlap context for the next.

    The overlap frames get partially noised — not clean (too rigid) and
    not fully noised (no context). The denoise strength controls how
    much freedom the model has to adjust the overlap region.

    Args:
        vae: VAE model
        last_frames: Last frames from previous segment [B, C, H, W] per frame
                     or [B, T, C, H, W] video tensor
        overlap_count: Number of frames to use as overlap
        noise_scheduler: The noise scheduler
        start_timestep: Starting timestep of the denoising process
        overlap_denoise: How much noise to add (0.0 = clean, 1.0 = full noise)

    Returns:
        Partially noised latents for the overlap region [B, C, overlap_T, H, W]
    """
    # Extract last N frames
    if last_frames.dim() == 5:
        # [B, T, C, H, W] or [B, C, T, H, W]
        overlap_frames = last_frames[:, -overlap_count:]
    elif last_frames.dim() == 4:
        # Single frame [B, C, H, W] — just use it
        overlap_frames = last_frames.unsqueeze(1)
    else:
        raise ValueError(f"Unexpected frame tensor shape: {last_frames.shape}")

    # Encode through VAE
    with torch.no_grad():
        overlap_latents = vae.encode(overlap_frames)
        if hasattr(overlap_latents, "latent_dist"):
            overlap_latents = overlap_latents.latent_dist.sample()
        elif hasattr(overlap_latents, "sample"):
            overlap_latents = overlap_latents.sample()

    # Add noise proportional to overlap_denoise
    # Higher denoise = more noise = more freedom to adjust
    noise = torch.randn_like(overlap_latents)

    # Scale the timestep by denoise strength
    effective_timestep = int(start_timestep * overlap_denoise)
    t = torch.tensor([effective_timestep], device=overlap_latents.device, dtype=torch.long)

    if effective_timestep > 0:
        noisy_overlap = noise_scheduler.add_noise(overlap_latents, noise, t)
    else:
        noisy_overlap = overlap_latents

    logger.info(
        f"Overlap encoded: {overlap_count} frames, "
        f"denoise={overlap_denoise}, effective_t={effective_timestep}"
    )

    return noisy_overlap


def blend_segments(
    segment_a: torch.Tensor,
    segment_b: torch.Tensor,
    overlap_frames: int = 8,
    blend_mode: str = "linear",
) -> torch.Tensor:
    """
    Blend two video segments at their overlap region.

    Args:
        segment_a: First segment [B, T_a, C, H, W]
        segment_b: Second segment [B, T_b, C, H, W]
        overlap_frames: Number of frames that overlap
        blend_mode: "linear" or "sigmoid" (smoother transitions)

    Returns:
        Stitched video tensor [B, T_total, C, H, W]
    """
    device = segment_a.device

    if overlap_frames <= 0:
        return torch.cat([segment_a, segment_b], dim=1)

    # Extract overlap regions
    overlap_a = segment_a[:, -overlap_frames:]  # End of A
    overlap_b = segment_b[:, :overlap_frames]   # Start of B

    # Create blend weights
    if blend_mode == "linear":
        weights = torch.linspace(1.0, 0.0, overlap_frames, device=device)
    elif blend_mode == "sigmoid":
        # Smoother S-curve transition
        x = torch.linspace(6.0, -6.0, overlap_frames, device=device)
        weights = torch.sigmoid(x)
    else:
        weights = torch.linspace(1.0, 0.0, overlap_frames, device=device)

    # Reshape weights for broadcasting: [1, T, 1, 1, 1]
    weights = weights.view(1, -1, 1, 1, 1)

    # Blend
    blended = overlap_a * weights + overlap_b * (1 - weights)

    # Stitch: A (minus overlap) + blended + B (minus overlap)
    result = torch.cat([
        segment_a[:, :-overlap_frames],
        blended,
        segment_b[:, overlap_frames:],
    ], dim=1)

    logger.info(
        f"Blended segments: A={segment_a.shape[1]}f + B={segment_b.shape[1]}f "
        f"→ {result.shape[1]}f (overlap={overlap_frames}, mode={blend_mode})"
    )

    return result


def multi_blend(
    segments: list,
    overlap_frames: int = 8,
    blend_mode: str = "linear",
) -> torch.Tensor:
    """
    Blend multiple segments sequentially.

    Args:
        segments: List of video tensors [B, T_i, C, H, W]
        overlap_frames: Number of overlap frames between each pair
        blend_mode: "linear" or "sigmoid"

    Returns:
        Fully stitched video tensor
    """
    if len(segments) == 0:
        raise ValueError("No segments to blend")
    if len(segments) == 1:
        return segments[0]

    result = segments[0]
    for i in range(1, len(segments)):
        result = blend_segments(result, segments[i], overlap_frames, blend_mode)

    return result
