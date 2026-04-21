"""
RefAttnExtract — Extracts identity features from a reference image.
"""

import torch
import numpy as np
from PIL import Image
import logging

logger = logging.getLogger("RefAttn")


class RefAttnExtract:

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "reference_image": ("IMAGE",),
                "model": ("MODEL",),
                "vae": ("VAE",),
                "face_weight": ("FLOAT", {
                    "default": 0.6, "min": 0.0, "max": 1.0, "step": 0.05,
                    "display": "slider",
                }),
                "extraction_timestep": ("INT", {
                    "default": 500, "min": 100, "max": 900, "step": 50,
                }),
            },
        }

    RETURN_TYPES = ("REF_FEATURES",)
    RETURN_NAMES = ("ref_features",)
    FUNCTION = "extract"
    CATEGORY = "RefAttn"

    def extract(self, reference_image, model, vae, face_weight=0.6, extraction_timestep=500):
        from ..core.feature_extraction import (
            FaceEncoder, CLIPImageEncoder, ReferenceKVExtractor, FeatureBank,
        )

        device = "cuda"

        # --- Image conversion ---
        img_tensor = reference_image[0]
        img_np = (img_tensor.cpu().numpy() * 255).astype(np.uint8)
        img_pil = Image.fromarray(img_np)

        # --- Face embedding (optional) ---
        face_embedding = None
        try:
            img_bgr = img_np[:, :, ::-1].copy()
            face_encoder = FaceEncoder(device=device)
            face_embedding = face_encoder.extract(img_bgr)
        except Exception as e:
            logger.warning(f"InsightFace failed: {e}")
            logger.info("Continuing without face embedding")

        # --- CLIP embedding (optional) ---
        clip_embedding = None
        try:
            clip_encoder = CLIPImageEncoder(device=device)
            clip_embedding = clip_encoder.extract(img_pil)
        except Exception as e:
            logger.warning(f"CLIP failed: {e}")

        # --- VAE encode reference image ---
        logger.info("Encoding reference image through VAE...")
        with torch.no_grad():
            try:
                # Use ComfyUI's VAE wrapper — it handles device/dtype management
                # ComfyUI VAE.encode() expects [B, H, W, C] in 0-1 range
                ref_latents = vae.encode(reference_image[:1])
            except Exception as e1:
                logger.warning(f"ComfyUI VAE encode failed: {e1}, trying direct")
                # Fallback: direct call with proper format
                img_5d = reference_image[:1].permute(0, 3, 1, 2).unsqueeze(2)
                img_5d = img_5d * 2.0 - 1.0
                inner_vae = vae.first_stage_model if hasattr(vae, 'first_stage_model') else vae
                # Move image to same device as VAE
                vae_device = next(inner_vae.parameters()).device
                vae_dtype = next(inner_vae.parameters()).dtype
                img_5d = img_5d.to(device=vae_device, dtype=vae_dtype)
                ref_latents = inner_vae.encode(img_5d)
                if isinstance(ref_latents, (tuple, list)):
                    ref_latents = ref_latents[0]

        # Ensure we have a proper tensor
        if hasattr(ref_latents, 'sample') and callable(ref_latents.sample):
            ref_latents = ref_latents.sample()
        ref_latents = ref_latents.float()

        # ComfyUI VAE.encode returns [B, C, H, W] — add temporal dim for Wan
        if ref_latents.dim() == 4:
            ref_latents = ref_latents.unsqueeze(2)  # [B, C, H, W] -> [B, C, 1, H, W]

        logger.info(f"VAE encoded: {ref_latents.shape}")

        # --- Extract reference K/V ---
        logger.info("Extracting reference K/V from DiT forward pass...")
        kv_extractor = ReferenceKVExtractor(device=device)

        # Get inner model for hooks, but use model wrapper for forward pass
        dit = model.model.diffusion_model if hasattr(model, 'model') else model
        inner_model = model.model if hasattr(model, 'model') else None

        # CRITICAL: Load model to GPU before forward pass
        # ComfyUI uses dynamic VRAM management — model may be on CPU
        try:
            import comfy.model_management
            comfy.model_management.load_model_gpu(model)
            logger.info("Model loaded to GPU for K/V extraction")
        except Exception as e:
            logger.warning(f"Could not pre-load model to GPU: {e}")

        # Move ref latents to GPU (VAE may return CPU tensor)
        ref_latents = ref_latents.to(device=device)

        reference_kv = kv_extractor.extract(
            dit_model=dit,
            reference_image_latents=ref_latents,
            extraction_timestep=extraction_timestep,
            model_wrapper=inner_model,
        )

        # --- Build FeatureBank ---
        bank = FeatureBank(
            face_embedding=face_embedding,
            clip_embedding=clip_embedding,
            reference_kv=reference_kv,
            face_weight=face_weight,
            appearance_weight=1.0 - face_weight,
        )

        logger.info(f"Extraction complete: {bank.summary()}")
        return (bank,)
