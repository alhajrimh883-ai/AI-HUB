"""
Core feature extraction for RefAttn.
"""

import torch
import numpy as np
from typing import Optional
import logging

logger = logging.getLogger("RefAttn")


class FaceEncoder:
    def __init__(self, device="cuda", det_size=(640, 640)):
        self.device = device
        self.det_size = det_size
        self.app = None

    def load(self):
        if self.app is not None:
            return
        from insightface.app import FaceAnalysis
        self.app = FaceAnalysis(
            name="buffalo_l",
            providers=["CUDAExecutionProvider", "CPUExecutionProvider"],
        )
        self.app.prepare(ctx_id=0, det_size=self.det_size)
        logger.info("InsightFace loaded successfully")

    def extract(self, image_np: np.ndarray) -> Optional[torch.Tensor]:
        self.load()
        faces = self.app.get(image_np)
        if not faces:
            logger.warning("No face detected in reference image")
            return None
        face = max(faces, key=lambda f: (f.bbox[2] - f.bbox[0]) * (f.bbox[3] - f.bbox[1]))
        embedding = torch.from_numpy(face.normed_embedding).float().to(self.device)
        logger.info(f"Face embedding extracted: shape={embedding.shape}")
        return embedding


class CLIPImageEncoder:
    def __init__(self, device="cuda"):
        self.device = device
        self.model = None
        self.processor = None

    def load(self, clip_model_path: Optional[str] = None):
        if self.model is not None:
            return
        from transformers import CLIPVisionModelWithProjection, CLIPImageProcessor
        model_id = clip_model_path or "openai/clip-vit-large-patch14"
        self.processor = CLIPImageProcessor.from_pretrained(model_id)
        self.model = CLIPVisionModelWithProjection.from_pretrained(model_id).to(self.device)
        self.model.eval()
        logger.info(f"CLIP image encoder loaded: {model_id}")

    def extract(self, image_pil) -> torch.Tensor:
        self.load()
        inputs = self.processor(images=image_pil, return_tensors="pt").to(self.device)
        with torch.no_grad():
            outputs = self.model(**inputs)
        embedding = outputs.image_embeds
        logger.info(f"CLIP embedding extracted: shape={embedding.shape}")
        return embedding


class ReferenceKVExtractor:
    """
    Extracts self-attention K/V from a reference image by running it
    through the DiT with hooks. These K/V pairs are in the model's
    native hidden space and can be concatenated into generation attention.
    """

    def __init__(self, device="cuda"):
        self.device = device
        self.cached_kv = {}
        self._hook_handles = []

    def _make_hook(self, layer_name: str):
        def hook_fn(module, input_args, output):
            hidden_states = input_args[0] if input_args else None
            if hidden_states is None:
                return
            with torch.no_grad():
                k = module.k(hidden_states)
                v = module.v(hidden_states)
                self.cached_kv[layer_name] = {
                    "k": k.detach().cpu(),
                    "v": v.detach().cpu(),
                }
        return hook_fn

    def extract(self, dit_model, reference_image_latents: torch.Tensor,
                extraction_timestep: int = 500, model_wrapper=None) -> dict:
        """
        Run a reference forward pass through the full DiT and cache K/V.

        Wan 2.2 patch_embedding expects 36 channels:
          [0:16]  = noisy latent
          [16:32] = clean image latent (I2V conditioning)
          [32:36] = mask (1.0 = image present)
        """
        self.cached_kv = {}
        self._hook_handles = []

        for name, module in dit_model.named_modules():
            if self._is_self_attention(name, module):
                handle = module.register_forward_hook(self._make_hook(name))
                self._hook_handles.append(handle)

        logger.info(f"Registered {len(self._hook_handles)} extraction hooks")
        if not self._hook_handles:
            return {}

        # --- Flow matching noise ---
        sigma = extraction_timestep / 1000.0
        noise = torch.randn_like(reference_image_latents)
        noisy_latents = (1.0 - sigma) * reference_image_latents + sigma * noise

        # --- Build 36-channel input ---
        # Wan 2.2 DiT expects: noisy(16) + clean_image(16) + mask(4)
        B, C, T, H, W = noisy_latents.shape
        device = noisy_latents.device
        dtype = noisy_latents.dtype

        # Detect expected input channels from patch_embedding
        expected_ch = 36
        if hasattr(dit_model, 'patch_embedding') and hasattr(dit_model.patch_embedding, 'weight'):
            expected_ch = dit_model.patch_embedding.weight.shape[1]
            logger.info(f"patch_embedding expects {expected_ch} channels")

        if expected_ch == 36:
            # Standard I2V: noisy(16) + clean(16) + mask(4)
            clean_latents = reference_image_latents.to(device=device, dtype=dtype)
            mask = torch.ones(B, 4, T, H, W, device=device, dtype=dtype)
            model_input = torch.cat([noisy_latents, clean_latents, mask], dim=1)
        elif expected_ch == 16:
            # T2V mode: just noisy latents
            model_input = noisy_latents
        else:
            # Unknown: pad with zeros to match
            extra = expected_ch - C
            padding = torch.zeros(B, extra, T, H, W, device=device, dtype=dtype)
            model_input = torch.cat([noisy_latents, padding], dim=1)

        logger.info(f"Model input: shape={model_input.shape}, sigma={sigma:.3f}")

        # --- Forward pass ---
        with torch.no_grad():
            try:
                if model_wrapper is not None:
                    timestep_tensor = torch.tensor([sigma], device=device, dtype=dtype)

                    # ComfyUI's apply_model builds xc = cat([x, c_concat], dim=1)
                    # So: x = noisy_latents (16ch)
                    #     c_concat = clean_latent(16ch) + mask(4ch) = 20ch
                    #     xc = 36ch total → matches patch_embedding
                    clean = reference_image_latents.to(device=device, dtype=dtype)
                    mask = torch.ones(B, 4, T, H, W, device=device, dtype=dtype)
                    c_concat = torch.cat([clean, mask], dim=1)  # [1, 20, 1, H, W]

                    dummy_context = torch.zeros(1, 1, 4096, device=device, dtype=dtype)

                    c = {
                        "c_crossattn": dummy_context,
                        "c_concat": c_concat,
                    }

                    logger.info(f"Calling apply_model: x={noisy_latents.shape}, c_concat={c_concat.shape}")

                    try:
                        model_wrapper.apply_model(noisy_latents, timestep_tensor, c=c)
                    except Exception as e1:
                        logger.warning(f"apply_model failed: {e1}")
                        logger.info("Trying direct forward_orig with 36ch input...")
                        self._direct_forward_36ch(dit_model, model_input, sigma)
                else:
                    self._direct_forward_36ch(dit_model, model_input, sigma)

            except Exception as e:
                logger.error(f"Reference forward pass failed: {e}")
                import traceback
                traceback.print_exc()

        # Cleanup hooks
        for handle in self._hook_handles:
            handle.remove()
        self._hook_handles = []

        logger.info(f"Extracted K/V from {len(self.cached_kv)} layers")
        if self.cached_kv:
            first = next(iter(self.cached_kv.values()))
            logger.info(f"  K shape: {first['k'].shape}, V shape: {first['v'].shape}")

        return self.cached_kv

    def _direct_forward_36ch(self, dit_model, model_input, sigma):
        """Call DiT forward directly with the 36-channel input."""
        device = model_input.device
        dtype = model_input.dtype

        timestep = torch.tensor([sigma], device=device, dtype=dtype)
        # Wan 2.2 text embedding: UMT5 output dim is 4096
        dummy_context = torch.zeros(1, 1, 4096, device=device, dtype=dtype)

        # Try the forward_orig signature from the traceback:
        # forward_orig(x, timestep, context, clip_fea=None, freqs=None, ...)
        try:
            dit_model.forward_orig(model_input, timestep, context=dummy_context)
            return
        except Exception as e:
            logger.warning(f"forward_orig failed: {e}")

        try:
            dit_model(model_input, timestep, context=dummy_context)
            return
        except Exception as e:
            logger.warning(f"forward with context failed: {e}")

        try:
            dit_model(model_input, timestep, dummy_context)
            return
        except Exception:
            pass

        raise RuntimeError("Could not call DiT forward with any signature")

    def _is_self_attention(self, name: str, module) -> bool:
        if name.endswith(".self_attn") and "cross_attn" not in name:
            if hasattr(module, "q") and hasattr(module, "k") and hasattr(module, "v"):
                return True
        return False


class FeatureBank:
    def __init__(self, face_embedding=None, clip_embedding=None,
                 reference_kv=None, face_weight=0.6, appearance_weight=0.4):
        self.face_embedding = face_embedding
        self.clip_embedding = clip_embedding
        self.reference_kv = reference_kv or {}
        self.face_weight = face_weight
        self.appearance_weight = appearance_weight

    def has_face(self):
        return self.face_embedding is not None

    def has_appearance(self):
        return self.clip_embedding is not None

    def has_kv(self):
        return len(self.reference_kv) > 0

    def num_layers(self):
        return len(self.reference_kv)

    def to(self, device):
        if self.face_embedding is not None:
            self.face_embedding = self.face_embedding.to(device)
        if self.clip_embedding is not None:
            self.clip_embedding = self.clip_embedding.to(device)
        for key in self.reference_kv:
            self.reference_kv[key] = {
                "k": self.reference_kv[key]["k"].to(device),
                "v": self.reference_kv[key]["v"].to(device),
            }
        return self

    def summary(self):
        parts = []
        if self.has_face():
            parts.append(f"face=[{self.face_embedding.shape}]")
        if self.has_appearance():
            parts.append(f"clip=[{self.clip_embedding.shape}]")
        if self.has_kv():
            first_k = next(iter(self.reference_kv.values()))["k"]
            parts.append(f"kv_layers={self.num_layers()} shape={first_k.shape}")
        return f"FeatureBank({', '.join(parts)})"
