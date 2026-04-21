"""
ComfyUI-LTXVideoExtend
Custom nodes for extending videos using LTX 2.3's inpainting/retake mechanism.

Nodes:
  - LTX Video Extend From Reference: Main node — encode + mask for extension
  - LTX Video Chain Extension: Chain multiple extensions for long-form video
  - LTX Video Overlap Blend: Blend decoded segments at overlap boundaries
  - LTX Video Frame Info: Utility — validate frame counts and plan extensions
  - LTX Video Extract Tail Frames: Helper — extract context frames for chaining
"""

from .nodes import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]

WEB_DIRECTORY = None
