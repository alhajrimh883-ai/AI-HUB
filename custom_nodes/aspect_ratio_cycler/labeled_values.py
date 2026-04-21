class _BaseNumber:
    CATEGORY = "EasyUse"
    FUNCTION = "run"

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {}}

    def run(self, **kwargs):
        return (next(iter(kwargs.values())),)


# FLOAT
class CFG_Float(_BaseNumber):
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"CFG": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 100.0, "step": 0.1})}}
    RETURN_TYPES = ("FLOAT",)
    RETURN_NAMES = ("CFG",)

class Shift_Float(_BaseNumber):
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"Shift": ("FLOAT", {"default": 10.0, "min": -1000.0, "max": 1000.0, "step": 0.1})}}
    RETURN_TYPES = ("FLOAT",)
    RETURN_NAMES = ("Shift",)

# INT
class TotalSteps_Int(_BaseNumber):
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"Total Steps": ("INT", {"default": 4, "min": 1, "max": 10000, "step": 1})}}
    RETURN_TYPES = ("INT",)
    RETURN_NAMES = ("Total Steps",)

class EndStepHigh_Int(_BaseNumber):
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"end step (high)": ("INT", {"default": 2, "min": 0, "max": 10000, "step": 1})}}
    RETURN_TYPES = ("INT",)
    RETURN_NAMES = ("end step (high)",)

class EndStepLow_Int(_BaseNumber):
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"end step (Low)": ("INT", {"default": 4, "min": 0, "max": 10000, "step": 1})}}
    RETURN_TYPES = ("INT",)
    RETURN_NAMES = ("end step (Low)",)

class Frames_Int(_BaseNumber):
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"Frames": ("INT", {"default": 81, "min": 1, "max": 100000, "step": 1})}}
    RETURN_TYPES = ("INT",)
    RETURN_NAMES = ("Frames",)