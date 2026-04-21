import torch
import numpy as np
import base64
import io
import os
import random
import time

try:
    from PIL import Image
except ImportError:
    Image = None

try:
    import folder_paths
    HAS_FOLDER_PATHS = True
except ImportError:
    HAS_FOLDER_PATHS = False

# ---------------------------------------------------------------------------
# Model cache — avoids reloading the VLM every run
# ---------------------------------------------------------------------------
_MODEL_CACHE = {
    "model": None,
    "params_hash": None,
}


def _scan_gguf_files():
    """Scan model directories for .gguf files and return sorted list."""
    search_dirs = []

    if HAS_FOLDER_PATHS:
        for name in ("LLM", "llm", "llm_gguf"):
            try:
                search_dirs.extend(folder_paths.get_folder_paths(name))
            except Exception:
                pass

    # Fallback: common ComfyUI model locations
    base = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    for sub in ("models/LLM", "models/llm", "models/llm_gguf"):
        search_dirs.append(os.path.join(base, sub))

    found = []
    seen = set()
    for d in search_dirs:
        if not os.path.isdir(d):
            continue
        for root, _, files in os.walk(d):
            for f in files:
                if f.lower().endswith(".gguf"):
                    full = os.path.join(root, f)
                    if full not in seen:
                        seen.add(full)
                        found.append(full)
    found.sort()
    return found if found else ["manual_path_required.gguf"]


def _tensor_to_base64(tensor_hwc, max_side=512):
    """Convert a single HWC float32 [0,1] tensor → base64 data-URI PNG (no label)."""
    if Image is None:
        raise ImportError("Pillow is required — pip install Pillow")
    arr = (tensor_hwc.cpu().numpy() * 255).clip(0, 255).astype(np.uint8)
    img = Image.fromarray(arr)
    w, h = img.size
    if max(w, h) > max_side:
        scale = max_side / max(w, h)
        img = img.resize((int(w * scale), int(h * scale)), Image.LANCZOS)
    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=True)
    return f"data:image/png;base64,{base64.b64encode(buf.getvalue()).decode()}"


def _tensor_to_labeled_base64(tensor_hwc, label_text, progress, max_side=512):
    """Convert tensor → base64 PNG with a visual label bar + progress bar burned in.

    Args:
        tensor_hwc: HWC float32 [0,1] image tensor
        label_text: e.g. "FRAME 1/16 | START | 0:00"
        progress:   0.0–1.0, position in the video (drives the progress bar)
        max_side:   max pixel dimension
    """
    if Image is None:
        raise ImportError("Pillow is required — pip install Pillow")

    from PIL import ImageDraw, ImageFont

    arr = (tensor_hwc.cpu().numpy() * 255).clip(0, 255).astype(np.uint8)
    img = Image.fromarray(arr)
    w, h = img.size
    if max(w, h) > max_side:
        scale = max_side / max(w, h)
        img = img.resize((int(w * scale), int(h * scale)), Image.LANCZOS)
        w, h = img.size

    # ── Font setup ──
    font_size = max(12, h // 20)
    try:
        font = ImageFont.truetype("arial.ttf", font_size)
    except (IOError, OSError):
        try:
            font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", font_size)
        except (IOError, OSError):
            font = ImageFont.load_default()

    # ── Measure text ──
    draw_temp = ImageDraw.Draw(img)
    bbox = draw_temp.textbbox((0, 0), label_text, font=font)
    text_w = bbox[2] - bbox[0]
    text_h = bbox[3] - bbox[1]

    # ── Top banner: semi-transparent black bar with white text ──
    banner_h = text_h + 12
    banner = Image.new("RGBA", (w, banner_h), (0, 0, 0, 180))
    banner_draw = ImageDraw.Draw(banner)
    text_x = (w - text_w) // 2
    text_y = 4
    banner_draw.text((text_x, text_y), label_text, fill=(255, 255, 255, 255), font=font)

    # Composite banner onto frame
    img = img.convert("RGBA")
    img.paste(banner, (0, 0), banner)

    # ── Bottom progress bar ──
    bar_h = max(4, h // 60)
    bar_y = h - bar_h
    progress_bar = Image.new("RGBA", (w, bar_h), (40, 40, 40, 160))
    bar_draw = ImageDraw.Draw(progress_bar)
    filled_w = int(w * progress)

    # Color gradient: green at start → yellow mid → red at end
    if progress < 0.5:
        r = int(255 * (progress * 2))
        g = 255
    else:
        r = 255
        g = int(255 * (1 - (progress - 0.5) * 2))
    bar_draw.rectangle([(0, 0), (filled_w, bar_h)], fill=(r, g, 50, 220))

    img.paste(progress_bar, (0, bar_y), progress_bar)

    # ── Encode ──
    img = img.convert("RGB")
    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=True)
    return f"data:image/png;base64,{base64.b64encode(buf.getvalue()).decode()}"


def _annotate_frame_tensor(tensor_hwc, label_text, progress):
    """Burn label onto a frame tensor and return a new HWC float32 [0,1] tensor.
    Used to create the annotated preview output (not for VLM encoding)."""
    if Image is None:
        raise ImportError("Pillow is required — pip install Pillow")

    from PIL import ImageDraw, ImageFont

    arr = (tensor_hwc.cpu().numpy() * 255).clip(0, 255).astype(np.uint8)
    img = Image.fromarray(arr)
    w, h = img.size

    font_size = max(12, h // 20)
    try:
        font = ImageFont.truetype("arial.ttf", font_size)
    except (IOError, OSError):
        try:
            font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", font_size)
        except (IOError, OSError):
            font = ImageFont.load_default()

    draw_temp = ImageDraw.Draw(img)
    bbox = draw_temp.textbbox((0, 0), label_text, font=font)
    text_w = bbox[2] - bbox[0]
    text_h = bbox[3] - bbox[1]

    banner_h = text_h + 12
    banner = Image.new("RGBA", (w, banner_h), (0, 0, 0, 180))
    banner_draw = ImageDraw.Draw(banner)
    banner_draw.text(((w - text_w) // 2, 4), label_text, fill=(255, 255, 255, 255), font=font)

    img = img.convert("RGBA")
    img.paste(banner, (0, 0), banner)

    bar_h = max(4, h // 60)
    bar_y = h - bar_h
    progress_bar = Image.new("RGBA", (w, bar_h), (40, 40, 40, 160))
    bar_draw = ImageDraw.Draw(progress_bar)
    filled_w = int(w * progress)
    if progress < 0.5:
        r = int(255 * (progress * 2))
        g = 255
    else:
        r = 255
        g = int(255 * (1 - (progress - 0.5) * 2))
    bar_draw.rectangle([(0, 0), (filled_w, bar_h)], fill=(r, g, 50, 220))
    img.paste(progress_bar, (0, bar_y), progress_bar)

    img = img.convert("RGB")
    return torch.from_numpy(np.array(img).astype(np.float32) / 255.0)


def _cache_key(model_path, clip_path, ctx, n_batch, gpu_layers, pool_size):
    return f"{model_path}|{clip_path}|{ctx}|{n_batch}|{gpu_layers}|{pool_size}"


# ===================================================================
# NODE 1 — Simple Frame Sampler (utility, no VLM)
# ===================================================================
class VLMVideoSampler:
    """Uniformly samples exactly target_frames from an image batch using linspace."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "images": ("IMAGE",),
                "target_frames": ("INT", {
                    "default": 16, "min": 1, "max": 256, "step": 1,
                    "tooltip": "Exact number of frames to output",
                }),
            },
            "optional": {
                "include_first_last": ("BOOLEAN", {"default": True}),
            },
        }

    RETURN_TYPES = ("IMAGE", "INT", "INT",)
    RETURN_NAMES = ("images", "total_frames", "sampled_count",)
    FUNCTION = "sample_frames"
    CATEGORY = "video/VLM"

    def sample_frames(self, images, target_frames=16, include_first_last=True):
        total = images.shape[0]
        if total <= target_frames:
            return (images, total, total)
        if include_first_last and target_frames >= 2:
            idx = torch.linspace(0, total - 1, target_frames).round().long()
        else:
            step = total / target_frames
            idx = torch.tensor([int(step * i) for i in range(target_frames)], dtype=torch.long)
        idx = torch.unique(idx, sorted=True)
        return (images[idx], total, idx.shape[0])


# ===================================================================
# NODE 2 — Qwen-VL Video Analyzer (all-in-one)
# ===================================================================
class QwenVLVideoAnalyzer:
    """
    All-in-one video→VLM node:
      • Uniformly samples target frames from the input batch
      • Loads Qwen3-VL via llama-cpp-python (model stays cached)
      • Sends sampled frames + system/user prompts
      • Outputs the sampled frames AND the VLM text response
    """

    @classmethod
    def INPUT_TYPES(cls):
        gguf_list = _scan_gguf_files()
        return {
            "required": {
                "images": ("IMAGE",),

                # --- Model paths ---
                "model_path": (gguf_list, {
                    "tooltip": "Qwen3-VL main GGUF model",
                }),
                "clip_model_path": (gguf_list, {
                    "tooltip": "Qwen3-VL mmproj / vision-encoder GGUF",
                }),

                # --- Prompts ---
                "system_prompt": ("STRING", {
                    "default": "You are a helpful video analysis assistant. Analyze the provided video frames and respond accurately and in detail.",
                    "multiline": True,
                    "tooltip": "System prompt — sets VLM behavior",
                }),
                "user_prompt": ("STRING", {
                    "default": "Describe what happens in this video in detail.",
                    "multiline": True,
                    "tooltip": "Your question / instruction to the VLM",
                }),

                # --- Frame sampling ---
                "target_frames": ("INT", {
                    "default": 16, "min": 1, "max": 128, "step": 1,
                    "tooltip": "How many frames the VLM will see",
                }),

                # --- Generation params (matches your screenshot) ---
                "output_max_tokens": ("INT", {
                    "default": 2048, "min": 64, "max": 16384, "step": 64,
                }),
                "image_max_tokens": ("INT", {
                    "default": 4096, "min": 512, "max": 32768, "step": 512,
                }),
                "ctx": ("INT", {
                    "default": 8192, "min": 1024, "max": 131072, "step": 1024,
                }),
                "n_batch": ("INT", {
                    "default": 512, "min": 64, "max": 4096, "step": 64,
                }),
                "gpu_layers": ("INT", {
                    "default": -1, "min": -1, "max": 200, "step": 1,
                    "tooltip": "-1 = all layers on GPU",
                }),
                "temperature": ("FLOAT", {
                    "default": 0.70, "min": 0.0, "max": 2.0, "step": 0.01,
                }),
                "seed": ("INT", {
                    "default": 1352, "min": 0, "max": 2**31 - 1, "step": 1,
                }),
                "control_after_generate": (["randomize", "fixed", "increment"],),
                "top_p": ("FLOAT", {
                    "default": 0.92, "min": 0.0, "max": 1.0, "step": 0.01,
                }),
                "repeat_penalty": ("FLOAT", {
                    "default": 1.20, "min": 0.0, "max": 3.0, "step": 0.01,
                }),
                "top_k": ("INT", {
                    "default": 0, "min": 0, "max": 1000, "step": 1,
                    "tooltip": "0 = disabled",
                }),
                "pool_size": ("INT", {
                    "default": 4194304, "min": 1024, "max": 67108864, "step": 1024,
                }),
            },
            "optional": {
                "unload_all_models": ("BOOLEAN", {"default": False}),
                "max_image_side": ("INT", {
                    "default": 512, "min": 128, "max": 2048, "step": 64,
                    "tooltip": "Resize frames so longest side ≤ this before encoding (saves VRAM)",
                }),
                "fps": ("FLOAT", {
                    "default": 24.0, "min": 1.0, "max": 120.0, "step": 0.1,
                    "tooltip": "Video FPS — used to calculate timestamps for each frame label",
                }),
            },
        }

    RETURN_TYPES = ("IMAGE", "STRING", "INT", "INT",)
    RETURN_NAMES = ("sampled_frames", "response", "total_frames", "sampled_count",)
    FUNCTION = "analyze_video"
    CATEGORY = "video/VLM"
    OUTPUT_NODE = True
    DESCRIPTION = (
        "Samples N frames from a video batch and sends them to Qwen3-VL for analysis. "
        "Outputs the sampled frames (IMAGE) and the VLM's text response (STRING)."
    )

    def analyze_video(
        self, images, model_path, clip_model_path,
        system_prompt, user_prompt, target_frames,
        output_max_tokens, image_max_tokens, ctx, n_batch,
        gpu_layers, temperature, seed, control_after_generate,
        top_p, repeat_penalty, top_k, pool_size,
        unload_all_models=False, max_image_side=512, fps=24.0,
    ):
        global _MODEL_CACHE
        LOG = "[Qwen-VL Video Analyzer]"

        # ── 1. SAMPLE FRAMES ─────────────────────────────────────────
        total = images.shape[0]
        if total <= target_frames:
            sampled = images
            frame_indices = list(range(total))
        else:
            idx = torch.linspace(0, total - 1, target_frames).round().long()
            idx = torch.unique(idx, sorted=True)
            sampled = images[idx]
            frame_indices = idx.tolist()
        sampled_count = sampled.shape[0]
        print(f"{LOG} Sampled {sampled_count}/{total} frames")

        # ── 2. ENCODE FRAMES & BUILD LABELS ──────────────────────────
        def _format_ts(frame_idx, fps_val):
            seconds = frame_idx / fps_val
            mins = int(seconds // 60)
            secs = seconds % 60
            return f"{mins}:{secs:05.2f}"

        mid_frame = total // 2
        b64_frames = []       # clean images for VLM (no overlay)
        frame_labels = []     # text labels per frame
        annotated_tensors = []  # labeled frames for user preview

        for i in range(sampled_count):
            orig_idx = frame_indices[i]
            progress = orig_idx / max(total - 1, 1)
            timestamp = _format_ts(orig_idx, fps)
            pct = int(progress * 100)

            if orig_idx == 0:
                pos = "START"
            elif orig_idx >= total - 1:
                pos = "END"
            elif abs(orig_idx - mid_frame) <= max(1, total // 20):
                pos = "MID"
            elif progress < 0.25:
                pos = "EARLY"
            elif progress < 0.50:
                pos = "EARLY-MID"
            elif progress < 0.75:
                pos = "MID-LATE"
            else:
                pos = "LATE"

            label = f"F{i+1}/{sampled_count}  #{orig_idx}/{total-1}  {timestamp}  {pct}%  {pos}"
            frame_labels.append(label)

            # Clean (no overlay) base64 for VLM — full image, nothing hidden
            b64_frames.append(_tensor_to_base64(sampled[i], max_side=max_image_side))

            # Annotated tensor for user preview output only
            annotated_tensors.append(_annotate_frame_tensor(sampled[i], label, progress))

        annotated_batch = torch.stack(annotated_tensors, dim=0)
        print(f"{LOG} Encoded {len(b64_frames)} frames (max_side={max_image_side})")

        # ── 3. LOAD / REUSE MODEL ────────────────────────────────────
        try:
            from llama_cpp import Llama
            from llama_cpp.llama_chat_format import Qwen3VLChatHandler
        except ImportError:
            raise ImportError(
                "llama-cpp-python with Qwen3-VL support is required.\n"
                "pip install llama-cpp-python --prefer-binary"
            )

        key = _cache_key(model_path, clip_model_path, ctx, n_batch, gpu_layers, pool_size)

        if _MODEL_CACHE["model"] is not None and _MODEL_CACHE["params_hash"] == key:
            llm = _MODEL_CACHE["model"]
            print(f"{LOG} Reusing cached model")
        else:
            # Free old model
            if _MODEL_CACHE["model"] is not None:
                del _MODEL_CACHE["model"]
                _MODEL_CACHE["model"] = None
                import gc; gc.collect()
                try:
                    torch.cuda.empty_cache()
                except Exception:
                    pass

            print(f"{LOG} Loading model … {os.path.basename(model_path)}")
            print(f"{LOG} Loading clip  … {os.path.basename(clip_model_path)}")

            handler = Qwen3VLChatHandler(
                clip_model_path=clip_model_path,
                verbose=False,
            )
            llm = Llama(
                model_path=model_path,
                chat_handler=handler,
                n_ctx=ctx,
                n_batch=n_batch,
                n_gpu_layers=gpu_layers,
                seed=seed if control_after_generate == "fixed" else -1,
                verbose=False,
            )
            _MODEL_CACHE["model"] = llm
            _MODEL_CACHE["params_hash"] = key
            print(f"{LOG} Model loaded & cached")

        # ── 4. SEED ──────────────────────────────────────────────────
        if control_after_generate == "randomize":
            actual_seed = random.randint(0, 2**31 - 1)
        elif control_after_generate == "increment":
            actual_seed = seed + 1
        else:
            actual_seed = seed

        # ── 5. BUILD MESSAGE ──────────────────────────────────────────
        # Text labels before each image act as "filenames" — VLM sees the
        # full unobstructed image AND knows its temporal position.
        video_duration = _format_ts(total - 1, fps)

        user_content = []
        user_content.append({
            "type": "text",
            "text": (
                f"[VIDEO — {total} frames, {sampled_count} sampled, "
                f"{fps} fps, duration {video_duration}]"
            ),
        })
        for i, b64 in enumerate(b64_frames):
            user_content.append({
                "type": "text",
                "text": f"[{frame_labels[i]}]",
            })
            user_content.append({
                "type": "image_url",
                "image_url": {"url": b64},
            })
        user_content.append({"type": "text", "text": user_prompt})

        messages = []
        if system_prompt and system_prompt.strip():
            messages.append({"role": "system", "content": system_prompt.strip()})
        messages.append({"role": "user", "content": user_content})

        # ── 6. INFERENCE ─────────────────────────────────────────────
        print(f"{LOG} Running inference … max_tokens={output_max_tokens}  temp={temperature}")
        t0 = time.time()

        try:
            resp = llm.create_chat_completion(
                messages=messages,
                max_tokens=output_max_tokens,
                temperature=temperature,
                top_p=top_p,
                top_k=top_k,
                repeat_penalty=repeat_penalty,
                seed=actual_seed,
            )
            text = ""
            if resp and "choices" in resp and resp["choices"]:
                msg = resp["choices"][0].get("message", {})
                text = msg.get("content", "")
            dt = time.time() - t0
            print(f"{LOG} Done in {dt:.1f}s — {len(text)} chars")
        except Exception as e:
            text = f"[ERROR] Inference failed: {e}"
            print(f"{LOG} ERROR: {e}")

        # ── 7. CLEANUP ───────────────────────────────────────────────
        if unload_all_models:
            print(f"{LOG} Unloading model (unload_all_models=True)")
            del _MODEL_CACHE["model"]
            _MODEL_CACHE["model"] = None
            _MODEL_CACHE["params_hash"] = None
            import gc; gc.collect()
            try:
                torch.cuda.empty_cache()
            except Exception:
                pass

        # ── 8. RETURN ────────────────────────────────────────────────
        return {
            "ui": {
                "text": [text],
                "sampled_count": [sampled_count],
                "total_frames": [total],
            },
            "result": (annotated_batch, text, total, sampled_count),
        }


# ===================================================================
# NODE 3 — VLM Response Display
# ===================================================================
class VLMResponseDisplay:
    """Shows VLM text response in the ComfyUI UI panel."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "text": ("STRING", {"forceInput": True}),
            },
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("text",)
    FUNCTION = "display"
    CATEGORY = "video/VLM"
    OUTPUT_NODE = True

    def display(self, text):
        return {"ui": {"text": [text]}, "result": (text,)}


# ===================================================================
# REGISTER
# ===================================================================
NODE_CLASS_MAPPINGS = {
    "VLMVideoSampler": VLMVideoSampler,
    "QwenVLVideoAnalyzer": QwenVLVideoAnalyzer,
    "VLMResponseDisplay": VLMResponseDisplay,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "VLMVideoSampler": "VLM Video Sampler",
    "QwenVLVideoAnalyzer": "Qwen-VL Video Analyzer",
    "VLMResponseDisplay": "VLM Response Display",
}
