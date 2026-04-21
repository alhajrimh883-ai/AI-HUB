# length_height_logic.py
from typing import Tuple, Any

class LengthHeightNode:
    def __init__(self):
        pass # ComfyUI often doesn't require a complex __init__ for basic nodes

    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "length": ("STRING", {"default": "0", "multiline": False}),
                "height": ("STRING", {"default": "0", "multiline": False}),
            },
            "optional": {
                # This boolean input acts as our "Reverse" button/trigger.
                # When set to True, the execute function will reverse the digits.
                "reverse_trigger": ("BOOLEAN", {"default": False, "forceInput": False})
            }
        }

    RETURN_TYPES = ("STRING", "STRING",)
    RETURN_NAMES = ("OUT_LENGTH", "OUT_HEIGHT",)

    FUNCTION = "execute"

    CATEGORY = "My Custom Nodes" # You can change this category as you like

    def reverse_digits(self, s: str) -> str:
        """
        Reverses the digits of a string-represented number.
        - Handles empty strings
        - Preserves the sign '-' if present
        """
        if s is None or s == '':
            return ''

        sign = '-' if s.startswith('-') else ''
        digits = s.lstrip('-')

        # Reverse digits
        reversed_digits = digits[::-1]

        return sign + reversed_digits

    def execute(self, length: str, height: str, reverse_trigger: bool = False) -> Tuple[str, str]:
        """
        Executes the node's logic.
        If reverse_trigger is True, reverses the digits of length and height before outputting.
        """
        if reverse_trigger:
            processed_length = self.reverse_digits(length)
            processed_height = self.reverse_digits(height)
        else:
            processed_length = length
            processed_height = height

        # Always return a tuple of outputs
        return (processed_length, processed_height,)
