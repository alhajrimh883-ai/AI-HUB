import os
import json

# Store presets alongside this file
PRESETS_PATH = os.path.join(os.path.dirname(__file__), "prompt_presets.json")


def _load_presets():
    if not os.path.exists(PRESETS_PATH):
        return {}
    try:
        with open(PRESETS_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, dict):
            # keep only string values
            return {str(k): str(v) for k, v in data.items()}
    except Exception:
        pass
    return {}


def _save_presets(presets: dict):
    tmp = PRESETS_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(presets, f, ensure_ascii=False, indent=2)
    os.replace(tmp, PRESETS_PATH)


class PromptPreset:
    """
    Save/load prompt strings by title.
    """

    @classmethod
    def INPUT_TYPES(cls):
        presets = _load_presets()
        titles = sorted(presets.keys())
        if not titles:
            titles = ["(none)"]

        return {
            "required": {
                "mode": (["load", "save", "delete"],),
                "title": (titles,),
            },
            "optional": {
                # Used when saving
                "new_title": ("STRING", {"default": "", "multiline": False}),
                "prompt_in": ("STRING", {"default": "", "multiline": True}),
            },
        }

    RETURN_TYPES = ("STRING", "STRING")
    RETURN_NAMES = ("prompt", "title")
    FUNCTION = "run"
    CATEGORY = "text/presets"

    def run(self, mode, title, new_title="", prompt_in=""):
        presets = _load_presets()

        if mode == "save":
            t = (new_title or title or "").strip()
            if not t:
                t = "Untitled"
            presets[t] = str(prompt_in)
            _save_presets(presets)
            return (presets[t], t)

        if mode == "delete":
            if title in presets:
                del presets[title]
                _save_presets(presets)
            return ("", "")

        # load
        if title == "(none)":
            return ("", "")
        return (presets.get(title, ""), title)


NODE_CLASS_MAPPINGS = {
    "PromptPreset": PromptPreset
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "PromptPreset": "Prompt Preset (Save/Load)"
}