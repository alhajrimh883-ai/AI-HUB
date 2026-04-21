import torch

class LatentTemporalSlice:
    """Slice a Wan video latent along the temporal dimension (dim=2).
    
    Wan latents are [B, C, T, H, W] where T = (num_frames - 1) / 4 + 1.
    For 81 frames, T = 21 temporal slots.
    """
    
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "samples": ("LATENT",),
                "start_frame": ("INT", {"default": 0, "min": -1000, "max": 1000, "step": 1, 
                                        "tooltip": "Start index along temporal dim. Negative values count from end. e.g. -10 = last 10 temporal slots"}),
                "length": ("INT", {"default": 10, "min": 1, "max": 1000, "step": 1,
                                   "tooltip": "Number of temporal slots to keep. 0 = all from start to end"}),
            }
        }

    RETURN_TYPES = ("LATENT", "INT",)
    RETURN_NAMES = ("samples", "temporal_length",)
    FUNCTION = "slice_temporal"
    CATEGORY = "latent/video"
    DESCRIPTION = "Slice Wan video latent [B,C,T,H,W] along the temporal dimension (dim 2). Use negative start_frame to count from end."

    def slice_temporal(self, samples, start_frame, length):
        s = samples["samples"]  # [B, C, T, H, W]
        T = s.shape[2]
        
        # Handle negative indexing
        if start_frame < 0:
            start_frame = max(0, T + start_frame)
        
        start_frame = min(start_frame, T - 1)
        end_frame = min(start_frame + length, T) if length > 0 else T
        
        sliced = s[:, :, start_frame:end_frame, :, :]
        
        out = samples.copy()
        out["samples"] = sliced
        
        # Remove noise_mask if present since it won't match
        if "noise_mask" in out:
            mask = out["noise_mask"]
            if mask.dim() >= 3 and mask.shape[2] == T:
                out["noise_mask"] = mask[:, :, start_frame:end_frame, :, :]
        
        return (out, sliced.shape[2],)


class LatentTemporalConcat:
    """Concatenate two Wan video latents along the temporal dimension (dim=2).
    
    Both latents must have matching B, C, H, W dimensions.
    Only T (temporal) can differ.
    """
    
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "samples_a": ("LATENT",),
                "samples_b": ("LATENT",),
            }
        }

    RETURN_TYPES = ("LATENT", "INT",)
    RETURN_NAMES = ("samples", "total_temporal_length",)
    FUNCTION = "concat_temporal"
    CATEGORY = "latent/video"
    DESCRIPTION = "Concatenate two Wan video latents [B,C,T,H,W] along the temporal dimension (dim 2). A comes first, B comes after."

    def concat_temporal(self, samples_a, samples_b):
        a = samples_a["samples"]  # [B, C, T1, H, W]
        b = samples_b["samples"]  # [B, C, T2, H, W]
        
        # Validate dimensions match except temporal
        if a.shape[0] != b.shape[0] or a.shape[1] != b.shape[1] or a.shape[3] != b.shape[3] or a.shape[4] != b.shape[4]:
            raise ValueError(
                f"Latent dimensions must match except temporal. "
                f"Got A={list(a.shape)} vs B={list(b.shape)}. "
                f"B, C, H, W must be identical."
            )
        
        concatenated = torch.cat([a, b], dim=2)
        
        out = samples_a.copy()
        out["samples"] = concatenated
        
        # Handle noise_mask concatenation
        if "noise_mask" in samples_a and "noise_mask" in samples_b:
            out["noise_mask"] = torch.cat([samples_a["noise_mask"], samples_b["noise_mask"]], dim=2)
        elif "noise_mask" in out:
            del out["noise_mask"]
        
        return (out, concatenated.shape[2],)


class LatentTemporalInfo:
    """Show the shape of a Wan video latent tensor for debugging."""
    
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "samples": ("LATENT",),
            }
        }

    RETURN_TYPES = ("LATENT", "INT", "INT", "INT", "INT", "INT", "INT",)
    RETURN_NAMES = ("samples", "batch", "channels", "temporal", "height", "width", "approx_frames",)
    FUNCTION = "info"
    CATEGORY = "latent/video"
    DESCRIPTION = "Output the shape info of a Wan video latent [B,C,T,H,W]. approx_frames = (T - 1) * 4 + 1."

    def info(self, samples):
        s = samples["samples"]
        B, C, T, H, W = s.shape
        approx_frames = (T - 1) * 4 + 1
        return (samples, B, C, T, H, W, approx_frames,)


class LatentTemporalDenoiseMask:
    """Generate a denoise mask for Wan video latents along the temporal dimension.
    
    Creates a mask where:
    - 0.0 = keep (no denoising, preserved from previous generation)
    - 1.0 = generate (full denoising, new content)
    
    The mask is shaped to match a Wan latent [B, 1, T, H, W].
    
    Use with LatentTemporalConcat: if you concat 11 overlap slots + 10 new slots = 21 total,
    set keep_slots=11, total_slots=21, and the first 11 will be 0 (keep) and last 10 will be 1 (generate).
    
    blend_slots creates a smooth gradient transition zone at the boundary to avoid hard seams.
    """
    
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "samples": ("LATENT", {"tooltip": "The latent to generate a mask for. Shape is read from this."}),
                "keep_slots": ("INT", {"default": 11, "min": 0, "max": 1000, "step": 1,
                                       "tooltip": "Number of temporal slots at the START to keep (denoise=0). These are your overlap frames from the previous clip."}),
                "blend_slots": ("INT", {"default": 2, "min": 0, "max": 100, "step": 1,
                                        "tooltip": "Number of temporal slots for gradient transition between keep and generate regions. 0 = hard boundary. Taken from the end of keep region."}),
                "keep_strength": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 1.0, "step": 0.01,
                                            "tooltip": "Denoise strength for the keep region. 0.0 = fully preserved. Small values like 0.05 allow subtle refinement."}),
                "generate_strength": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 1.0, "step": 0.01,
                                                "tooltip": "Denoise strength for the generate region. 1.0 = fully new content."}),
            }
        }

    RETURN_TYPES = ("LATENT", "MASK",)
    RETURN_NAMES = ("samples_with_mask", "mask_preview",)
    FUNCTION = "make_mask"
    CATEGORY = "latent/video"
    DESCRIPTION = "Generate a temporal denoise mask for Wan video latents. Marks overlap frames as keep (0) and new frames as generate (1), with optional gradient blending."

    def make_mask(self, samples, keep_slots, blend_slots, keep_strength, generate_strength):
        s = samples["samples"]  # [B, C, T, H, W]
        B, C, T, H, W = s.shape
        
        # Clamp values
        keep_slots = min(keep_slots, T)
        blend_slots = min(blend_slots, keep_slots)  # blend zone sits inside the keep region
        
        # Build 1D temporal mask
        mask_1d = torch.zeros(T, dtype=s.dtype, device=s.device)
        
        # Keep region (before blend)
        hard_keep_end = keep_slots - blend_slots
        if hard_keep_end > 0:
            mask_1d[:hard_keep_end] = keep_strength
        
        # Blend region (gradient from keep_strength to generate_strength)
        if blend_slots > 0:
            blend_start = hard_keep_end
            blend_end = keep_slots
            for i in range(blend_slots):
                t = (i + 1) / (blend_slots + 1)  # 0->1 exclusive of endpoints
                mask_1d[blend_start + i] = keep_strength + t * (generate_strength - keep_strength)
        
        # Generate region
        if keep_slots < T:
            mask_1d[keep_slots:] = generate_strength
        
        # Expand to [B, 1, T, H, W] 
        mask = mask_1d.view(1, 1, T, 1, 1).expand(B, 1, T, H, W).clone()
        
        # Attach to latent
        out = samples.copy()
        out["noise_mask"] = mask
        
        # Also output a 2D preview mask [T, 1] expanded to [T, W] for visualization
        mask_preview = mask_1d.unsqueeze(0)  # [1, T]
        
        return (out, mask_preview,)


class LatentTemporalMaskFromLatents:
    """Auto-generate a denoise mask based on two latents you're about to concat.
    
    Takes latent_a (keep) and latent_b (generate), reads their temporal sizes,
    and builds the mask automatically. No manual slot counting needed.
    """
    
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "keep_latent": ("LATENT", {"tooltip": "The overlap latent (will be marked as keep/no-denoise)"}),
                "generate_latent": ("LATENT", {"tooltip": "The new latent (will be marked as generate/full-denoise)"}),
                "blend_slots": ("INT", {"default": 2, "min": 0, "max": 100, "step": 1}),
                "keep_strength": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 1.0, "step": 0.01}),
                "generate_strength": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 1.0, "step": 0.01}),
            }
        }

    RETURN_TYPES = ("MASK",)
    RETURN_NAMES = ("noise_mask",)
    FUNCTION = "make_mask"
    CATEGORY = "latent/video"
    DESCRIPTION = "Auto-generate temporal denoise mask from two latents. Reads their T dimensions to set keep vs generate regions."

    def make_mask(self, keep_latent, generate_latent, blend_slots, keep_strength, generate_strength):
        T_keep = keep_latent["samples"].shape[2]
        T_gen = generate_latent["samples"].shape[2]
        T_total = T_keep + T_gen
        
        s = keep_latent["samples"]
        B, C, _, H, W = s.shape
        
        blend_slots = min(blend_slots, T_keep)
        hard_keep_end = T_keep - blend_slots
        
        mask_1d = torch.zeros(T_total, dtype=s.dtype, device=s.device)
        
        # Keep region
        if hard_keep_end > 0:
            mask_1d[:hard_keep_end] = keep_strength
        
        # Blend region
        if blend_slots > 0:
            for i in range(blend_slots):
                t = (i + 1) / (blend_slots + 1)
                mask_1d[hard_keep_end + i] = keep_strength + t * (generate_strength - keep_strength)
        
        # Generate region
        mask_1d[T_keep:] = generate_strength
        
        mask = mask_1d.view(1, 1, T_total, 1, 1).expand(B, 1, T_total, H, W).clone()
        
        return (mask,)


class LatentApplyTemporalMask:
    """Apply a noise_mask to a LATENT dict."""
    
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "samples": ("LATENT",),
                "mask": ("MASK",),
            }
        }

    RETURN_TYPES = ("LATENT",)
    FUNCTION = "apply"
    CATEGORY = "latent/video"

    def apply(self, samples, mask):
        out = samples.copy()
        out["noise_mask"] = mask
        return (out,)


NODE_CLASS_MAPPINGS = {
    "LatentTemporalSlice": LatentTemporalSlice,
    "LatentTemporalConcat": LatentTemporalConcat,
    "LatentTemporalInfo": LatentTemporalInfo,
    "LatentTemporalDenoiseMask": LatentTemporalDenoiseMask,
    "LatentTemporalMaskFromLatents": LatentTemporalMaskFromLatents,
    "LatentApplyTemporalMask": LatentApplyTemporalMask,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "LatentTemporalSlice": "Latent Temporal Slice (Video)",
    "LatentTemporalConcat": "Latent Temporal Concat (Video)",
    "LatentTemporalInfo": "Latent Temporal Info (Video)",
    "LatentTemporalDenoiseMask": "Latent Temporal Denoise Mask (Video)",
    "LatentTemporalMaskFromLatents": "Latent Temporal Mask From Latents (Video)",
    "LatentApplyTemporalMask": "Latent Apply Temporal Mask (Video)",
}
