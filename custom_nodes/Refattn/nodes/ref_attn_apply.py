"""
RefAttnApply — Patches the model with identity injection.
Uses ComfyUI's model patching API for clean, compatible integration.
"""

import logging

logger = logging.getLogger("RefAttn")


class RefAttnApply:

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "model": ("MODEL",),
                "ref_features": ("REF_FEATURES",),
                "schedule": ("REF_SCHEDULE",),
            },
        }

    RETURN_TYPES = ("MODEL",)
    RETURN_NAMES = ("model",)
    FUNCTION = "apply"
    CATEGORY = "RefAttn"

    def apply(self, model, ref_features, schedule):
        from ..core.attention_patcher import RefAttnPatcher

        # Clone model (ComfyUI convention for non-destructive patching)
        patched_model = model.clone()

        patcher = RefAttnPatcher()

        scheduler_fn = schedule["scheduler_fn"]
        total_steps = schedule["total_steps"]

        # Pass the ComfyUI ModelPatcher — NOT the raw DiT
        # The patcher will use set_model_attn1_patch() which is the
        # same mechanism IP-Adapter and PuLID use
        patcher.patch(
            model_patcher=patched_model,
            feature_bank=ref_features,
            scheduler_fn=scheduler_fn,
            total_steps=total_steps,
        )

        logger.info("RefAttn applied to model")
        return (patched_model,)
