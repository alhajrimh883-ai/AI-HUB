# custom_nodes/RunButtonNode/__init__.py

class RunButtonNode:
    """
    This node doesn't "run the workflow" by itself.
    It's mainly a placeholder so we can attach a UI button to it via a JS extension.
    """
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {}}

    RETURN_TYPES = ()
    FUNCTION = "noop"
    CATEGORY = "utils"

    def noop(self):
        return ()

NODE_CLASS_MAPPINGS = {
    "RunButtonNode": RunButtonNode
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "RunButtonNode": "Run Workflow Button"
}