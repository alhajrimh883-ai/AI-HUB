import random
import sys
import os

# 1. Add the parent directory to path
current_dir = os.path.dirname(os.path.abspath(__file__))
parent_dir = os.path.dirname(current_dir)
sys.path.append(parent_dir)

# 2. Import from rp_utils
try:
    from rp_utils import get_json_files, load_json_data
except ImportError:
    from ..rp_utils import get_json_files, load_json_data

class BodyBuildGenerator:
    def __init__(self):
        pass

    @classmethod
    def INPUT_TYPES(s):
        file_list = get_json_files("body_build")
        return {
            "required": {
                "seed": ("INT", {"default": 0, "min": 0, "max": 0xffffffffffffffff}),
                "build_type": (file_list,), 
            }
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("prompt",)
    FUNCTION = "generate_build"
    CATEGORY = "MyCustomNodes/Body"

    def generate_build(self, seed, build_type):
        if build_type == "No files found":
            return ("",)

        data = load_json_data("body_build", build_type)
        if not data:
            return ("Error: Empty or Invalid JSON",)

        rng = random.Random(seed)
        selected_tags = []

        # Iterate through every category
        for category_name, category_items in data.items():
            options = []
            
            # Case A: Simple List ["tag1", "tag2"] (This is what you want now)
            if isinstance(category_items, list):
                options = category_items
            
            # Case B: Numbered Dict {"0":"tag1", "1":"tag2"} (Old style backup)
            elif isinstance(category_items, dict):
                options = list(category_items.values())

            # Pick a tag if options exist
            if options:
                choice = rng.choice(options)
                if isinstance(choice, str) and choice.strip() != "":
                    selected_tags.append(choice)

        final_prompt = ", ".join(selected_tags)
        return (final_prompt,)