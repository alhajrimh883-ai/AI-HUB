import random
import sys
import os

# 1. Setup path to find rp_utils
current_dir = os.path.dirname(os.path.abspath(__file__))
parent_dir = os.path.dirname(current_dir)
sys.path.append(parent_dir)

# 2. Import helper functions
try:
    from rp_utils import load_json_data
except ImportError:
    from ..rp_utils import load_json_data

class GirlBoySelector:
    def __init__(self):
        pass

    @classmethod
    def INPUT_TYPES(s):
        # 1. Read the JSON file specifically
        # We look in 'data/girl_boy/' for 'girl-boy amount.json'
        data = load_json_data("girl_boy", "girl-boy amount.json")
        
        # 2. Prepare default options
        girl_options = ["Disabled", "Random"]
        boy_options = ["Disabled", "Random"]
        
        # 3. Fill the lists from the file
        if data:
            # Handle 'girls' category
            if "girls" in data:
                items = data["girls"]
                if isinstance(items, list):
                    girl_options.extend(items)
                elif isinstance(items, dict):
                    girl_options.extend(list(items.values()))
            
            # Handle 'boys' category
            if "boys" in data:
                items = data["boys"]
                if isinstance(items, list):
                    boy_options.extend(items)
                elif isinstance(items, dict):
                    boy_options.extend(list(items.values()))

        return {
            "required": {
                "seed": ("INT", {"default": 0, "min": 0, "max": 0xffffffffffffffff}),
                "girl_count": (girl_options, {"default": "Random"}),
                "boy_count": (boy_options, {"default": "Disabled"}),
            }
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("prompt",)
    FUNCTION = "process_selection"
    CATEGORY = "MyCustomNodes/Character"

    def process_selection(self, seed, girl_count, boy_count):
        rng = random.Random(seed)
        selected_tags = []

        # Logic for Girls
        if girl_count != "Disabled":
            if girl_count == "Random":
                # We need to re-read the list to pick a random one securely
                data = load_json_data("girl_boy", "girl-boy amount.json")
                if data and "girls" in data:
                    items = data["girls"]
                    # Handle List or Dict
                    options = items if isinstance(items, list) else list(items.values())
                    if options:
                        selected_tags.append(rng.choice(options))
            else:
                # User selected a specific tag (e.g., "1girl")
                selected_tags.append(girl_count)

        # Logic for Boys
        if boy_count != "Disabled":
            if boy_count == "Random":
                data = load_json_data("girl_boy", "girl-boy amount.json")
                if data and "boys" in data:
                    items = data["boys"]
                    options = items if isinstance(items, list) else list(items.values())
                    if options:
                        selected_tags.append(rng.choice(options))
            else:
                selected_tags.append(boy_count)

        final_prompt = ", ".join(selected_tags)
        return (final_prompt,)