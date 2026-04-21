from .tag_picker_node import PersonalTagFilePicker
from .string_combine_node import PersonalStringCombine

NODE_CLASS_MAPPINGS = {
    "PersonalTagFilePicker": PersonalTagFilePicker,
    "PersonalStringCombine": PersonalStringCombine,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "PersonalTagFilePicker": "Personal Tag File Picker (dropdown)",
    "PersonalStringCombine": "Personal String Combine",
}