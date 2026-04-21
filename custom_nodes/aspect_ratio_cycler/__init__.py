class AspectRatioCycler:
    PRESETS = {
        "Square": (640, 640),
        "Landscape": (848, 480),
        "Portrait": (480, 848),
    }

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                # Renders as radio-style options in ComfyUI (one active at a time), not a dropdown
                "aspect": (["Square", "Landscape", "Portrait"], {"default": "Square"}),
            }
        }

    RETURN_TYPES = ("INT", "INT")
    RETURN_NAMES = ("width", "height")
    FUNCTION = "run"
    CATEGORY = "utils"

    def run(self, aspect: str):
        w, h = self.PRESETS[aspect]
        return (w, h)


NODE_CLASS_MAPPINGS = {"Aspect Ratio Cycler": AspectRatioCycler}
NODE_DISPLAY_NAME_MAPPINGS = {"Aspect Ratio Cycler": "Aspect Ratio Cycler"}
from .t2i_ratios import T2IRatios

NODE_CLASS_MAPPINGS["T2I Ratios"] = T2IRatios
NODE_DISPLAY_NAME_MAPPINGS["T2I Ratios"] = "T2I Ratios"

from .labeled_values import (
    CFG_Float, TotalSteps_Int, EndStepHigh_Int, EndStepLow_Int, Frames_Int, Shift_Float
)

NODE_CLASS_MAPPINGS.update({
    "CFG": CFG_Float,
    "Total Steps": TotalSteps_Int,
    "end step (high)": EndStepHigh_Int,
    "end step (Low)": EndStepLow_Int,
    "Frames": Frames_Int,
    "Shift": Shift_Float,
})

NODE_DISPLAY_NAME_MAPPINGS.update({
    "CFG": "CFG",
    "Total Steps": "Total Steps",
    "end step (high)": "end step (high)",
    "end step (Low)": "end step (Low)",
    "Frames": "Frames",
    "Shift": "Shift",
})