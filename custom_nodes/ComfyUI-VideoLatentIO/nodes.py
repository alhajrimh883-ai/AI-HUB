import os
import re
import json
import torch
import numpy as np
import subprocess
import folder_paths
from safetensors.torch import save_file, load_file


def _find_chunks(folder, prefix, ext):
    """Find all {prefix}_NNNNN.{ext} files, return sorted list of (number, filepath)."""
    if not os.path.exists(folder):
        return []
    pattern = re.compile(rf"^{re.escape(prefix)}_(\d+)\.{re.escape(ext)}$")
    chunks = []
    for f in os.listdir(folder):
        m = pattern.match(f)
        if m:
            chunks.append((int(m.group(1)), os.path.join(folder, f)))
    chunks.sort(key=lambda x: x[0])
    return chunks


def _next_chunk(folder, prefix, ext):
    """Get the next chunk number and filepath."""
    chunks = _find_chunks(folder, prefix, ext)
    next_num = (chunks[-1][0] + 1) if chunks else 1
    return next_num, os.path.join(folder, f"{prefix}_{next_num:05d}.{ext}")


def _pick_chunk(folder, prefix, ext, chunk_number):
    """Pick latest (0) or specific chunk. Returns (num, path, total) or None."""
    chunks = _find_chunks(folder, prefix, ext)
    if not chunks:
        return None
    total = len(chunks)
    if chunk_number > 0:
        match = [c for c in chunks if c[0] == chunk_number]
        if not match:
            available = [c[0] for c in chunks]
            raise FileNotFoundError(f"Chunk #{chunk_number} not found. Available: {available}")
        return match[0][0], match[0][1], total
    return chunks[-1][0], chunks[-1][1], total


def _get_ffmpeg():
    for name in ("ffmpeg", "ffmpeg.exe"):
        p = os.path.join(os.path.dirname(os.path.abspath(__file__)), name)
        if os.path.isfile(p):
            return p
    return "ffmpeg"


def _get_ffprobe():
    for name in ("ffprobe", "ffprobe.exe"):
        p = os.path.join(os.path.dirname(os.path.abspath(__file__)), name)
        if os.path.isfile(p):
            return p
    return "ffprobe"


# ──────────────────────────────────────────────────────────────
# Latent Chunks
# ──────────────────────────────────────────────────────────────

class SaveLatentChunk:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "latent": ("LATENT",),
                "save_folder": ("STRING", {"default": "E:/SVI_Latents"}),
                "file_name": ("STRING", {"default": "chunk"}),
            },
        }

    RETURN_TYPES = ("STRING", "INT")
    RETURN_NAMES = ("saved_file", "chunk_number")
    FUNCTION = "save"
    OUTPUT_NODE = True
    CATEGORY = "video/io"

    def save(self, latent, save_folder, file_name):
        save_folder, file_name = save_folder.strip(), file_name.strip()
        os.makedirs(save_folder, exist_ok=True)

        next_num, filepath = _next_chunk(save_folder, file_name, "latent")

        tensors = {"latent_tensor": latent["samples"]}
        for key, value in latent.items():
            if key != "samples" and isinstance(value, torch.Tensor):
                tensors[f"latent_{key}"] = value

        save_file(tensors, filepath)
        size_mb = os.path.getsize(filepath) / (1024 * 1024)
        print(f"[SaveLatentChunk] #{next_num}: {filepath} ({list(latent['samples'].shape)}, {size_mb:.2f}MB)")

        return (filepath, next_num)


class LoadLatentChunk:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "load_folder": ("STRING", {"default": "E:/SVI_Latents"}),
                "file_name": ("STRING", {"default": "chunk"}),
                "chunk_number": ("INT", {"default": 0, "min": 0, "max": 99999,
                                         "tooltip": "0 = load latest. Set a number to load that specific chunk."}),
            },
            "optional": {
                "fallback_latent": ("LATENT",),
            },
        }

    RETURN_TYPES = ("LATENT", "STRING", "INT")
    RETURN_NAMES = ("latent", "loaded_file", "total_chunks")
    FUNCTION = "load"
    CATEGORY = "video/io"

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return float("nan")

    def load(self, load_folder, file_name, chunk_number=0, fallback_latent=None):
        load_folder, file_name = load_folder.strip(), file_name.strip()
        result = _pick_chunk(load_folder, file_name, "latent", chunk_number)

        if result is None:
            if fallback_latent is not None:
                print(f"[LoadLatentChunk] No chunks for '{file_name}' — using fallback")
                return (fallback_latent, "fallback", 0)
            raise FileNotFoundError(f"No chunks for '{file_name}' in {load_folder}. Connect a fallback latent.")

        target_num, target_path, total = result
        tensors = load_file(target_path)

        latent = {"samples": tensors["latent_tensor"]}
        for key, value in tensors.items():
            if key.startswith("latent_") and key != "latent_tensor":
                latent[key[len("latent_"):]] = value

        name = os.path.basename(target_path)
        print(f"[LoadLatentChunk] #{target_num}: {name} ({list(latent['samples'].shape)}) — {total} total")

        return (latent, name, total)


# ──────────────────────────────────────────────────────────────
# Video Chunks
# ──────────────────────────────────────────────────────────────

class SaveVideoChunk:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "images": ("IMAGE",),
                "save_folder": ("STRING", {"default": "E:/SVI_Videos"}),
                "file_name": ("STRING", {"default": "video"}),
                "fps": ("FLOAT", {"default": 16.0, "min": 1.0, "max": 120.0, "step": 0.5}),
                "quality": ("INT", {"default": 20, "min": 1, "max": 51, "step": 1,
                                    "tooltip": "CRF value. Lower = better. 18-23 visually lossless."}),
            },
        }

    RETURN_TYPES = ("STRING", "INT")
    RETURN_NAMES = ("saved_file", "chunk_number")
    FUNCTION = "save"
    OUTPUT_NODE = True
    CATEGORY = "video/io"

    def save(self, images, save_folder, file_name, fps, quality):
        save_folder, file_name = save_folder.strip(), file_name.strip()
        os.makedirs(save_folder, exist_ok=True)

        next_num, filepath = _next_chunk(save_folder, file_name, "mp4")

        frames = images.cpu().numpy()
        num_frames, h, w = frames.shape[0], frames.shape[1], frames.shape[2]
        h_enc, w_enc = h - (h % 2), w - (w % 2)

        cmd = [
            _get_ffmpeg(), "-y",
            "-f", "rawvideo", "-vcodec", "rawvideo",
            "-s", f"{w_enc}x{h_enc}", "-pix_fmt", "rgb24",
            "-r", str(fps), "-i", "-",
            "-c:v", "libx264", "-crf", str(quality),
            "-pix_fmt", "yuv420p", "-preset", "slow",
            "-movflags", "+faststart", filepath,
        ]

        process = subprocess.Popen(cmd, stdin=subprocess.PIPE, stderr=subprocess.PIPE)
        for i in range(num_frames):
            frame = (np.clip(frames[i], 0, 1) * 255).astype(np.uint8)
            process.stdin.write(frame[:h_enc, :w_enc, :].tobytes())
        process.stdin.close()
        stderr = process.stderr.read()
        process.wait()
        if process.returncode != 0:
            raise RuntimeError(f"ffmpeg failed:\n{stderr.decode()}")

        size_mb = os.path.getsize(filepath) / (1024 * 1024)
        print(f"[SaveVideoChunk] #{next_num}: {filepath} ({num_frames}f @ {w_enc}x{h_enc}, {size_mb:.2f}MB)")

        return (filepath, next_num)


class LoadVideoChunk:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "load_folder": ("STRING", {"default": "E:/SVI_Videos"}),
                "file_name": ("STRING", {"default": "video"}),
                "chunk_number": ("INT", {"default": 0, "min": 0, "max": 99999,
                                         "tooltip": "0 = load latest. Set a number to load that specific chunk."}),
            },
            "optional": {
                "fallback_images": ("IMAGE",),
            },
        }

    RETURN_TYPES = ("IMAGE", "STRING", "INT", "INT")
    RETURN_NAMES = ("images", "loaded_file", "frame_count", "total_chunks")
    FUNCTION = "load"
    CATEGORY = "video/io"

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return float("nan")

    def load(self, load_folder, file_name, chunk_number=0, fallback_images=None):
        load_folder, file_name = load_folder.strip(), file_name.strip()
        result = _pick_chunk(load_folder, file_name, "mp4", chunk_number)

        if result is None:
            if fallback_images is not None:
                print(f"[LoadVideoChunk] No chunks for '{file_name}' — using fallback")
                return (fallback_images, "fallback", fallback_images.shape[0], 0)
            raise FileNotFoundError(f"No chunks for '{file_name}' in {load_folder}. Connect fallback images.")

        target_num, target_path, total = result

        # Probe
        probe = subprocess.run(
            [_get_ffprobe(), "-v", "error", "-select_streams", "v:0",
             "-show_entries", "stream=width,height", "-of", "json", target_path],
            capture_output=True, text=True)
        if probe.returncode != 0:
            raise RuntimeError(f"ffprobe failed: {probe.stderr}")
        stream = json.loads(probe.stdout)["streams"][0]
        w, h = int(stream["width"]), int(stream["height"])

        # Decode
        dec = subprocess.run(
            [_get_ffmpeg(), "-i", target_path, "-f", "rawvideo",
             "-pix_fmt", "rgb24", "-v", "error", "-"],
            capture_output=True)
        if dec.returncode != 0:
            raise RuntimeError(f"ffmpeg decode failed: {dec.stderr.decode()}")

        frame_size = w * h * 3
        num_frames = len(dec.stdout) // frame_size
        frames_np = np.frombuffer(dec.stdout[:num_frames * frame_size], dtype=np.uint8)
        images = torch.from_numpy(frames_np.reshape(num_frames, h, w, 3).copy()).float() / 255.0

        name = os.path.basename(target_path)
        print(f"[LoadVideoChunk] #{target_num}: {name} ({num_frames}f @ {w}x{h}) — {total} total")

        return (images, name, num_frames, total)


# ──────────────────────────────────────────────────────────────

NODE_CLASS_MAPPINGS = {
    "SaveLatentChunk": SaveLatentChunk,
    "LoadLatentChunk": LoadLatentChunk,
    "SaveVideoChunk": SaveVideoChunk,
    "LoadVideoChunk": LoadVideoChunk,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "SaveLatentChunk": "Save Latent Chunk",
    "LoadLatentChunk": "Load Latent Chunk",
    "SaveVideoChunk": "Save Video Chunk",
    "LoadVideoChunk": "Load Video Chunk",
}
