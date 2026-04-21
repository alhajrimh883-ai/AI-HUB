class PersonalStringCombine:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "a": ("STRING", {"default": ""}),
                "b": ("STRING", {"default": ""}),
                "separator": ("STRING", {"default": ", "}),
            }
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("text",)
    FUNCTION = "run"
    CATEGORY = "personal"

    def run(self, a, b, separator):
        a = (a or "").strip()
        b = (b or "").strip()
        if not a:
            return (b,)
        if not b:
            return (a,)
        return (a + separator + b,)