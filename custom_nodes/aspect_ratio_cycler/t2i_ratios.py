import torch

class T2IRatios:
    PRESETS = {
        "Square": (1024, 1024),
        "Landscape": (1216, 832),
        "Portrait": (832, 1216),
    }

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                # May render as radio options or a dropdown depending on UI; still single-choice.
                "aspect": (["Square", "Landscape", "Portrait"], {"default": "Square"}),

                # Latent batch size
                "batch_size": ("INT", {"default": 1, "min": 1, "max": 64, "step": 1}),
            }
        }

    RETURN_TYPES = ("LATENT", "INT", "INT")
    RETURN_NAMES = ("latent", "width", "height")
    FUNCTION = "run"
    CATEGORY = "utils"

    def run(self, aspect: str, batch_size: int):
        width, height = self.PRESETS[aspect]

        # ComfyUI latents are (B, 4, H/8, W/8)
        h8 = height // 8
        w8 = width // 8

        latent = {"samples": torch.zeros((batch_size, 4, h8, w8), dtype=torch.float32)}
        return (latent, width, height)