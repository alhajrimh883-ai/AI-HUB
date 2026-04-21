from .nodes.node_body_build import BodyBuildGenerator
from .nodes.node_girl_boy import GirlBoySelector

NODE_CLASS_MAPPINGS = {
    "BodyBuildGenerator": BodyBuildGenerator,
    "GirlBoySelector": GirlBoySelector
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "BodyBuildGenerator": "Random Body Build (JSON)",
    "GirlBoySelector": "Girl/Boy Counter"
}

__all__ = ['NODE_CLASS_MAPPINGS', 'NODE_DISPLAY_NAME_MAPPINGS']