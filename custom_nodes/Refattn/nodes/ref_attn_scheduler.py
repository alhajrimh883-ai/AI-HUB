"""
RefAttnScheduler — Configures the timestep-based injection schedule.
Controls WHEN and HOW MUCH identity gets injected during denoising.
"""

import logging

logger = logging.getLogger("RefAttn")


class RefAttnScheduler:
    """Configure identity injection schedule."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "mode": (["balanced", "identity_heavy", "prompt_heavy", "front_loaded", "constant"], {
                    "default": "balanced",
                    "tooltip": "Schedule curve shape.\n"
                               "balanced: peaks mid-denoise (best default)\n"
                               "identity_heavy: strong identity throughout\n"
                               "prompt_heavy: minimal identity, max prompt\n"
                               "front_loaded: identity first, prompt later\n"
                               "constant: flat injection",
                }),
                "strength": ("FLOAT", {
                    "default": 0.6,
                    "min": 0.0,
                    "max": 1.0,
                    "step": 0.05,
                    "display": "slider",
                    "tooltip": "Global injection strength multiplier.",
                }),
                "start_percent": ("FLOAT", {
                    "default": 0.05,
                    "min": 0.0,
                    "max": 1.0,
                    "step": 0.05,
                    "display": "slider",
                    "tooltip": "When to start injection (% of denoise steps). "
                               "0.05 = skip first 5% to let prompt set composition.",
                }),
                "end_percent": ("FLOAT", {
                    "default": 0.95,
                    "min": 0.0,
                    "max": 1.0,
                    "step": 0.05,
                    "display": "slider",
                    "tooltip": "When to stop injection. "
                               "0.95 = let last 5% refine naturally.",
                }),
                "total_steps": ("INT", {
                    "default": 30,
                    "min": 1,
                    "max": 100,
                    "step": 1,
                    "tooltip": "Must match your KSampler steps.",
                }),
            },
            "optional": {
                "segment_index": ("INT", {
                    "default": 0,
                    "min": 0,
                    "max": 50,
                    "step": 1,
                    "tooltip": "Current segment number for drift compensation. "
                               "0 for first segment.",
                }),
                "drift_compensation": (["auto", "off"], {
                    "default": "auto",
                    "tooltip": "Auto: slightly boost identity for later segments "
                               "to counter accumulated drift.",
                }),
            },
        }

    RETURN_TYPES = ("REF_SCHEDULE",)
    RETURN_NAMES = ("schedule",)
    FUNCTION = "create_schedule"
    CATEGORY = "RefAttn"

    def create_schedule(
        self,
        mode="balanced",
        strength=0.6,
        start_percent=0.05,
        end_percent=0.95,
        total_steps=30,
        segment_index=0,
        drift_compensation="auto",
    ):
        from ..core.scheduler import make_scheduler, preview_schedule

        scheduler_fn = make_scheduler(
            mode=mode,
            strength=strength,
            start_percent=start_percent,
            end_percent=end_percent,
            segment_index=segment_index,
            drift_compensation=drift_compensation,
        )

        # Preview the schedule for logging
        preview = preview_schedule(
            mode=mode,
            strength=strength,
            start_percent=start_percent,
            end_percent=end_percent,
            total_steps=total_steps,
            segment_index=segment_index,
        )

        peak = max(w for _, w in preview)
        active_steps = sum(1 for _, w in preview if w > 0.01)

        logger.info(
            f"Schedule: mode={mode}, strength={strength:.2f}, "
            f"range=[{start_percent:.0%}–{end_percent:.0%}], "
            f"peak={peak:.3f}, active_steps={active_steps}/{total_steps}"
        )

        schedule = {
            "scheduler_fn": scheduler_fn,
            "total_steps": total_steps,
            "mode": mode,
            "strength": strength,
            "segment_index": segment_index,
        }

        return (schedule,)
