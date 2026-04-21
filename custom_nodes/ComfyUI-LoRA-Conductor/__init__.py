"""
ComfyUI-LoRA-Conductor

The model uses the LoRA — not the other way around.

Reads LoRA training metadata, matches against your prompt,
and computes budget-allocated strengths automatically.
No slow delta computation. Runs in under a second.
"""

from .conductor import LoRAConductor

NODE_CLASS_MAPPINGS = {
    "LoRAConductor": LoRAConductor,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "LoRAConductor": "LoRA Conductor",
}

WEB_DIRECTORY = "./js"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
