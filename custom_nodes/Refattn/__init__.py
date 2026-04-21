"""
ComfyUI-RefAttn: Reference Attention for Wan 2.2
Preserves identity from a reference image while maintaining full prompt following.
"""

from .nodes.ref_attn_extract import RefAttnExtract
from .nodes.ref_attn_apply import RefAttnApply
from .nodes.ref_attn_extend import RefAttnExtend
from .nodes.ref_attn_scheduler import RefAttnScheduler
from .nodes.ref_attn_blend import RefAttnBlendSegments

NODE_CLASS_MAPPINGS = {
    "RefAttnExtract": RefAttnExtract,
    "RefAttnApply": RefAttnApply,
    "RefAttnExtend": RefAttnExtend,
    "RefAttnScheduler": RefAttnScheduler,
    "RefAttnBlendSegments": RefAttnBlendSegments,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "RefAttnExtract": "RefAttn Extract Features",
    "RefAttnApply": "RefAttn Apply to Model",
    "RefAttnExtend": "RefAttn Extend Video",
    "RefAttnScheduler": "RefAttn Timestep Scheduler",
    "RefAttnBlendSegments": "RefAttn Blend Segments",
}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
