# __init__.py
# Custom node for ComfyUI: LengthHeightNode
# Provides inputs for length and height, outputs them as STRING and INT,
# and a 'Reverse' action to reverse digits.

from typing import Tuple, Any

class LengthHeightNode:
    def __init__(self):
        pass

    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "length": ("STRING", {"default": "0", "multiline": False}),
                "height": ("STRING", {"default": "0", "multiline": False}),
            },
            "optional": {
                "reverse_trigger": ("BOOLEAN", {"default": False})
            }
        }

    # Now returning four outputs: STRING length, STRING height, INT length, INT height
    RETURN_TYPES = ("STRING", "STRING", "INT", "INT",)
    RETURN_NAMES = ("OUT_LENGTH_STR", "OUT_HEIGHT_STR", "OUT_LENGTH_INT", "OUT_HEIGHT_INT",)

    FUNCTION = "execute"

    CATEGORY = "My Custom Nodes"

    def reverse_digits(self, s: str) -> str:
        if s is None or s == '':
            return ''
        sign = '-' if s.startswith('-') else ''
        digits = s.lstrip('-')
        reversed_digits = digits[::-1]
        return sign + reversed_digits

    def execute(self, length: str, height: str, reverse_trigger: bool = False) -> Tuple[str, str, int, int]:
        """
        Executes the node's logic.
        If reverse_trigger is True, reverses the digits of length and height before outputting.
        Outputs are provided as both STRING and INT types.
        """
        if reverse_trigger:
            processed_length_str = self.reverse_digits(length)
            processed_height_str = self.reverse_digits(height)
        else:
            processed_length_str = length
            processed_height_str = height

        # Convert to int for the INT outputs
        try:
            processed_length_int = int(processed_length_str)
        except ValueError:
            print(f"Warning: Could not convert length '{processed_length_str}' to integer. Using 0.")
            processed_length_int = 0

        try:
            processed_height_int = int(processed_height_str)
        except ValueError:
            print(f"Warning: Could not convert height '{processed_height_str}' to integer. Using 0.")
            processed_height_int = 0

        return (processed_length_str, processed_height_str, processed_length_int, processed_height_int,)

# A dictionary that contains all nodes you want to export with this custom node
NODE_CLASS_MAPPINGS = {
    "LengthHeightNode": LengthHeightNode
}

# A dictionary that contains the friendly names for the nodes.
NODE_DISPLAY_NAME_MAPPINGS = {
    "LengthHeightNode": "Length/Height Node"
}

__all__ = ['NODE_CLASS_MAPPINGS', 'NODE_DISPLAY_NAME_MAPPINGS']