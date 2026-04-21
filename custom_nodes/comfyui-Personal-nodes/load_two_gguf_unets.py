import os
import importlib
import folder_paths


def _list_gguf_in(folder_key: str):
    # Resolve absolute folder(s) ComfyUI uses for this key
    folders = folder_paths.get_folder_paths(folder_key)
    if isinstance(folders, str):
        folders = [folders]

    out = []
    for d in folders:
        if not d or not os.path.isdir(d):
            continue
        for root, _, files in os.walk(d):
            for f in files:
                if f.lower().endswith(".gguf"):
                    full = os.path.join(root, f)
                    rel = os.path.relpath(full, d).replace("\\", "/")
                    out.append(rel)
    out.sort(key=str.lower)
    return out


class LoadTwoUNetGGUF:
    @classmethod
    def INPUT_TYPES(cls):
        ggufs = _list_gguf_in("diffusion_models")
        if not ggufs:
            # fallback keys some setups use
            ggufs = _list_gguf_in("unet") or _list_gguf_in("unets")

        return {
            "required": {
                "unet_name_a": (ggufs, ),
                "unet_name_b": (ggufs, ),
            }
        }

    RETURN_TYPES = ("MODEL", "MODEL")
    RETURN_NAMES = ("model_a", "model_b")
    FUNCTION = "load"
    CATEGORY = "loaders/GGUF"

    def load(self, unet_name_a, unet_name_b):
        gguf_nodes = importlib.import_module("ComfyUI_GGUF.nodes")

        loader_cls = getattr(gguf_nodes, "S_RunetLoaderGGUF", None)
        if loader_cls is None:
            for k, v in gguf_nodes.__dict__.items():
                if isinstance(v, type) and k.lower().endswith("runetloadergguf"):
                    loader_cls = v
                    break

        if loader_cls is None:
            raise RuntimeError(
                "Could not find ComfyUI-GGUF loader class for 'Unet Loader (GGUF)'."
            )

        loader = loader_cls()

        # Call whichever method exists
        fn = getattr(loader, "load", None) or getattr(loader, "run", None)
        if fn is None:
            raise RuntimeError("Loader class has neither .load() nor .run().")

        model_a = fn(unet_name_a)[0]
        model_b = fn(unet_name_b)[0]
        return (model_a, model_b)


NODE_CLASS_MAPPINGS = {"LoadTwoUNetGGUF": LoadTwoUNetGGUF}
NODE_DISPLAY_NAME_MAPPINGS = {"LoadTwoUNetGGUF": "Load Two UNets (GGUF)"}