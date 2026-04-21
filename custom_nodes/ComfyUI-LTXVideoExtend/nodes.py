"""
ComfyUI-LTXVideoExtend v3
Fixed: Color flash and audio gibberish at extension boundary.

Root cause: v2 padded extension frames with flat gray (0.5) and audio with zeros,
creating a hard discontinuity the VAE encodes as a latent spike. The denoiser 
can't fully smooth this — you get color artifacts and garbled audio.

Fix: Pad with LAST FRAME repeated (video) and FADE-OUT (audio), giving the VAE
a smooth signal. The noise mask still controls what gets regenerated.

Author: Claude (Anthropic)
License: MIT
"""

import torch
import torch.nn.functional as F
import math

try:
    import comfy.model_management as mm
except ImportError:
    mm = None


# === UTILITY FUNCTIONS ===

def snap_to_ltx_frame_count(n: int) -> int:
    """LTX 2.3 requires frame counts of the form 8k + 1."""
    if n <= 1:
        return 1
    k = math.ceil((n - 1) / 8)
    return 8 * k + 1


def snap_to_divisible(val: int, divisor: int) -> int:
    return math.ceil(val / divisor) * divisor


def build_temporal_mask_1d(total_frames, keep_frames, overlap_frames=0, blend_mode="cosine"):
    """Build 1D noise mask: 0=keep original, 1=generate, 0..1=blend."""
    mask = torch.zeros(total_frames, dtype=torch.float32)
    if keep_frames < total_frames:
        mask[keep_frames:] = 1.0
    if overlap_frames > 0 and blend_mode != "none":
        overlap_start = max(0, keep_frames - overlap_frames)
        for i in range(overlap_start, min(keep_frames, total_frames)):
            t = (i - overlap_start + 1) / (overlap_frames + 1)
            if blend_mode == "cosine":
                mask[i] = 0.5 * (1.0 - math.cos(math.pi * t))
            elif blend_mode == "linear":
                mask[i] = t
    return mask


def frames_to_latent_count(pixel_frames, temporal_stride=8):
    """LTX 2.3: latent_T = (pixel_T - 1) // 8 + 1"""
    return max(1, (pixel_frames - 1) // temporal_stride + 1)


def build_video_padding(last_frame_bchw, num_pad_frames, pad_mode="last_frame_fade", fade_length=16):
    """
    Build padding frames for the extension region.
    
    Modes:
      last_frame: Repeat the last frame for all padding (best for VAE continuity)
      last_frame_fade: Repeat last frame, gradually fade to 0.5 gray (balanced)
      gray: Flat 0.5 gray (old behavior — causes color flash)
    
    The key insight: the VAE encodes these frames, but the noise mask ensures
    they get regenerated. What matters is that the VAE doesn't see a DISCONTINUITY
    at the boundary, because that discontinuity leaks through as color artifacts.
    """
    C, H, W = last_frame_bchw.shape[0], last_frame_bchw.shape[1], last_frame_bchw.shape[2]
    device = last_frame_bchw.device
    dtype = last_frame_bchw.dtype
    
    if pad_mode == "gray":
        return torch.full((num_pad_frames, C, H, W), 0.5, dtype=dtype, device=device)
    
    elif pad_mode == "last_frame":
        # Pure repeat — smoothest for VAE, noise mask handles the rest
        return last_frame_bchw.unsqueeze(0).expand(num_pad_frames, -1, -1, -1).clone()
    
    elif pad_mode == "last_frame_fade":
        # Repeat last frame but gradually blend toward 0.5 over fade_length frames
        # This gives the VAE smooth input AND signals "unknown" for distant frames
        padding = last_frame_bchw.unsqueeze(0).expand(num_pad_frames, -1, -1, -1).clone()
        
        actual_fade = min(fade_length, num_pad_frames)
        for i in range(num_pad_frames):
            if i < actual_fade:
                # Gradual fade: frame 0 = 100% last frame, frame fade_length = 100% gray
                alpha = i / actual_fade
                # Cosine fade is smoother than linear
                alpha = 0.5 * (1.0 - math.cos(math.pi * alpha))
                padding[i] = padding[i] * (1.0 - alpha) + 0.5 * alpha
            else:
                # Beyond fade length, full gray
                padding[i] = 0.5
        
        return padding
    
    else:
        # Default to last_frame_fade
        return build_video_padding(last_frame_bchw, num_pad_frames, "last_frame_fade", fade_length)


def build_audio_latent_padding(last_audio_slice, num_pad_steps, fade_length=None):
    """
    Pad audio latent by fading from last values to zero instead of hard zeros.
    Prevents the garbled audio at the extension boundary.
    """
    if fade_length is None:
        fade_length = min(num_pad_steps, max(4, num_pad_steps // 3))
    
    # Get shape info from the last slice
    if last_audio_slice.dim() == 1:
        # [C] -> expand to [num_pad, C]
        padding = last_audio_slice.unsqueeze(0).expand(num_pad_steps, -1).clone()
    elif last_audio_slice.dim() == 2:
        # [C, F] -> expand to [num_pad, C, F]
        padding = last_audio_slice.unsqueeze(0).expand(num_pad_steps, -1, -1).clone()
    else:
        padding = last_audio_slice.unsqueeze(0).expand(num_pad_steps, *last_audio_slice.shape).clone()
    
    # Fade to zero
    for i in range(num_pad_steps):
        if i < fade_length:
            alpha = i / fade_length
            alpha = 0.5 * (1.0 - math.cos(math.pi * alpha))  # cosine fade
            padding[i] = padding[i] * (1.0 - alpha)
        else:
            padding[i] = 0.0
    
    return padding


# === NODE 1: LTXVideoExtendFromReference v3 ===

class LTXVideoExtendFromReference:
    """
    Encodes reference video and creates masked latent for extension.
    
    v3 fixes: Pads extension with last-frame repeat + fade instead of gray,
    eliminating color flash at boundary. Audio pads with fade-out instead of
    zeros, fixing garbled audio.
    
    Outputs SEPARATE video_latent and audio_latent.
    Connect both to LTXVConcatAVLatent before sampling.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "video_frames": ("IMAGE",),
                "vae": ("VAE", {"tooltip": "LTX 2.3 Video VAE"}),
                "extension_seconds": ("FLOAT", {
                    "default": 5.0, "min": 0.5, "max": 60.0, "step": 0.5,
                }),
                "fps": ("FLOAT", {
                    "default": 24.0, "min": 1.0, "max": 60.0, "step": 1.0,
                }),
                "overlap_frames": ("INT", {
                    "default": 16, "min": 0, "max": 64, "step": 1,
                    "tooltip": "Pixel frames for soft blend at extension boundary (16-24 recommended)"
                }),
                "blend_mode": (["cosine", "linear", "none"], {"default": "cosine"}),
                "pad_mode": (["last_frame_fade", "last_frame", "gray"], {
                    "default": "last_frame_fade",
                    "tooltip": "How to fill extension frames before encoding. last_frame_fade = smoothest (recommended). gray = old behavior (causes color flash)."
                }),
                "fade_length": ("INT", {
                    "default": 16, "min": 4, "max": 64, "step": 4,
                    "tooltip": "How many frames over which the padding fades from last frame to gray (for last_frame_fade mode)"
                }),
                "width": ("INT", {
                    "default": 0, "min": 0, "max": 4096, "step": 32,
                    "tooltip": "0 = auto from input"
                }),
                "height": ("INT", {
                    "default": 0, "min": 0, "max": 4096, "step": 32,
                    "tooltip": "0 = auto from input"
                }),
            },
            "optional": {
                "audio_waveform": ("AUDIO", {"tooltip": "Reference audio to encode and extend"}),
                "audio_vae": ("VAE", {"tooltip": "LTX 2.3 Audio VAE"}),
            }
        }

    RETURN_TYPES = ("LATENT", "LATENT", "INT", "INT", "FLOAT")
    RETURN_NAMES = ("video_latent", "audio_latent", "total_frames", "extension_start_frame", "fps")
    FUNCTION = "execute"
    CATEGORY = "video_models/ltx_extend"
    DESCRIPTION = (
        "v3: Encodes reference video with smooth boundary padding to eliminate color "
        "flash and audio gibberish at the extension point. Outputs separate video_latent "
        "and audio_latent for LTXVConcatAVLatent."
    )

    def execute(self, video_frames, vae, extension_seconds, fps,
                overlap_frames, blend_mode, pad_mode, fade_length,
                width, height, audio_waveform=None, audio_vae=None):

        num_input_frames = video_frames.shape[0]
        input_h, input_w = video_frames.shape[1], video_frames.shape[2]

        # Resolve dimensions
        if width <= 0:
            width = snap_to_divisible(input_w, 32)
        if height <= 0:
            height = snap_to_divisible(input_h, 32)

        # Frame counts (8k+1)
        extension_pixel_frames = max(1, int(extension_seconds * fps))
        total_pixel_frames = snap_to_ltx_frame_count(num_input_frames + extension_pixel_frames)
        actual_extension = total_pixel_frames - num_input_frames

        print(f"[LTXExtend v3] Input: {num_input_frames}f ({num_input_frames/fps:.1f}s)")
        print(f"[LTXExtend v3] Extension: {actual_extension}f ({actual_extension/fps:.1f}s)")
        print(f"[LTXExtend v3] Total: {total_pixel_frames}f | Pad: {pad_mode} | Overlap: {overlap_frames}")

        # Resize input frames
        frames_bchw = video_frames.permute(0, 3, 1, 2).float()
        if frames_bchw.shape[2] != height or frames_bchw.shape[3] != width:
            frames_bchw = F.interpolate(frames_bchw, size=(height, width), mode="bilinear", align_corners=False)

        # *** KEY FIX: Smart padding instead of flat gray ***
        last_frame = frames_bchw[-1]  # [C, H, W] — the last real frame
        padding = build_video_padding(last_frame, actual_extension, pad_mode, fade_length)

        all_frames = torch.cat([frames_bchw, padding], dim=0).permute(0, 2, 3, 1)  # -> [B, H, W, C]

        # ===== VIDEO LATENT =====
        print(f"[LTXExtend v3] Encoding {all_frames.shape[0]} frames...")
        encoded = vae.encode(all_frames[:, :, :, :3])
        video_samples = encoded["samples"] if isinstance(encoded, dict) else encoded
        print(f"[LTXExtend v3] Video latent: {video_samples.shape}")

        # Latent dims
        if video_samples.dim() == 5:
            latent_t, h_lat, w_lat = video_samples.shape[2], video_samples.shape[3], video_samples.shape[4]
        else:
            latent_t = 1
            h_lat = video_samples.shape[-2] if video_samples.dim() >= 2 else 1
            w_lat = video_samples.shape[-1] if video_samples.dim() >= 1 else 1

        # Temporal noise mask
        input_latent_t = frames_to_latent_count(num_input_frames)
        overlap_lat = frames_to_latent_count(max(overlap_frames, 1)) if overlap_frames > 0 else 0

        mask_1d = build_temporal_mask_1d(latent_t, input_latent_t, overlap_lat, blend_mode)

        noise_mask = mask_1d.view(1, latent_t, 1, 1).expand(1, latent_t, h_lat, w_lat)
        noise_mask = noise_mask.clone().to(device=video_samples.device, dtype=video_samples.dtype)

        print(f"[LTXExtend v3] Mask: keep={input_latent_t}, overlap={overlap_lat}, "
              f"generate={latent_t - input_latent_t}")

        video_latent_out = {"samples": video_samples, "noise_mask": noise_mask}

        # ===== AUDIO LATENT =====
        audio_latent_out = None

        if audio_waveform is not None and audio_vae is not None:
            try:
                print(f"[LTXExtend v3] Encoding audio...")
                audio_encoded = audio_vae.encode(audio_waveform)
                audio_samples = audio_encoded["samples"] if isinstance(audio_encoded, dict) else audio_encoded
                print(f"[LTXExtend v3] Audio latent: {audio_samples.shape}")

                audio_t = audio_samples.shape[2] if audio_samples.dim() >= 3 else audio_samples.shape[-1]
                target_audio_t = int(math.ceil(audio_t * (total_pixel_frames / max(num_input_frames, 1))))

                # *** KEY FIX: Fade-out padding instead of zeros ***
                if target_audio_t > audio_t:
                    pad_t = target_audio_t - audio_t

                    if audio_samples.dim() == 4:  # [B, C, T, F]
                        last_audio = audio_samples[:, :, -1, :]  # [B, C, F]
                        # Build fade padding for each batch item
                        fade_pad = build_audio_latent_padding(
                            audio_samples[0, :, -1, :],  # [C, F]
                            pad_t
                        )
                        # Reshape: [pad_t, C, F] -> [1, C, pad_t, F]
                        fade_pad = fade_pad.permute(1, 0, 2).unsqueeze(0)
                        audio_samples = torch.cat([audio_samples, fade_pad.to(audio_samples.device)], dim=2)

                    elif audio_samples.dim() == 3:  # [B, C, T]
                        fade_pad = build_audio_latent_padding(
                            audio_samples[0, :, -1],  # [C]
                            pad_t
                        )
                        # Reshape: [pad_t, C] -> [1, C, pad_t]
                        fade_pad = fade_pad.permute(1, 0).unsqueeze(0)
                        audio_samples = torch.cat([audio_samples, fade_pad.to(audio_samples.device)], dim=2)

                    print(f"[LTXExtend v3] Audio padded (fade-out): {audio_samples.shape}")

                # Audio mask
                new_audio_t = audio_samples.shape[2] if audio_samples.dim() >= 3 else audio_samples.shape[-1]
                audio_mask_1d = build_temporal_mask_1d(
                    new_audio_t, audio_t,
                    min(overlap_lat, audio_t),
                    blend_mode
                )

                if audio_samples.dim() == 4:
                    audio_mask = audio_mask_1d.view(1, new_audio_t, 1).expand(1, new_audio_t, audio_samples.shape[3])
                elif audio_samples.dim() == 3:
                    audio_mask = audio_mask_1d.view(1, new_audio_t)
                else:
                    audio_mask = audio_mask_1d

                audio_mask = audio_mask.clone().to(device=audio_samples.device, dtype=audio_samples.dtype)
                audio_latent_out = {"samples": audio_samples, "noise_mask": audio_mask}
                print(f"[LTXExtend v3] Audio latent ready")

            except Exception as e:
                print(f"[LTXExtend v3] Audio failed: {e}")
                audio_latent_out = None

        if audio_latent_out is None:
            dev = video_samples.device
            audio_latent_out = {"samples": torch.zeros(1, 64, latent_t, dtype=torch.float32, device=dev)}
            print(f"[LTXExtend v3] Empty audio. Use LTXVEmptyLatentAudio for proper empty audio.")

        return (video_latent_out, audio_latent_out, total_pixel_frames, num_input_frames, fps)


# === NODE 2: LTXVideoChainExtension v3 ===

class LTXVideoChainExtension:
    """Chain extensions with same boundary fixes as v3."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "prev_video_frames": ("IMAGE",),
                "vae": ("VAE",),
                "extension_seconds": ("FLOAT", {"default": 5.0, "min": 0.5, "max": 60.0, "step": 0.5}),
                "fps": ("FLOAT", {"default": 24.0, "min": 1.0, "max": 60.0, "step": 1.0}),
                "context_frames": ("INT", {"default": 33, "min": 9, "max": 97, "step": 8}),
                "overlap_frames": ("INT", {"default": 16, "min": 0, "max": 64, "step": 1}),
                "blend_mode": (["cosine", "linear", "none"], {"default": "cosine"}),
                "pad_mode": (["last_frame_fade", "last_frame", "gray"], {"default": "last_frame_fade"}),
                "fade_length": ("INT", {"default": 16, "min": 4, "max": 64, "step": 4}),
            },
            "optional": {
                "prev_audio": ("AUDIO",),
                "audio_vae": ("VAE",),
            },
        }

    RETURN_TYPES = ("LATENT", "LATENT", "INT", "INT", "INT", "FLOAT")
    RETURN_NAMES = ("video_latent", "audio_latent", "total_frames", "context_count", "ext_start", "fps")
    FUNCTION = "execute"
    CATEGORY = "video_models/ltx_extend"

    def execute(self, prev_video_frames, vae, extension_seconds, fps,
                context_frames, overlap_frames, blend_mode, pad_mode, fade_length,
                prev_audio=None, audio_vae=None):

        num_prev = prev_video_frames.shape[0]
        context_frames = min(snap_to_ltx_frame_count(min(context_frames, num_prev)), num_prev)
        context = prev_video_frames[max(0, num_prev - context_frames):]
        actual_ctx = context.shape[0]

        total_pix = snap_to_ltx_frame_count(actual_ctx + max(1, int(extension_seconds * fps)))
        actual_ext = total_pix - actual_ctx
        h = snap_to_divisible(context.shape[1], 32)
        w = snap_to_divisible(context.shape[2], 32)

        print(f"[LTXChain v3] Ctx: {actual_ctx}, Ext: {actual_ext}, Total: {total_pix}")

        frames_bchw = context.permute(0, 3, 1, 2).float()
        if frames_bchw.shape[2] != h or frames_bchw.shape[3] != w:
            frames_bchw = F.interpolate(frames_bchw, size=(h, w), mode="bilinear", align_corners=False)

        # *** Smart padding ***
        last_frame = frames_bchw[-1]
        padding = build_video_padding(last_frame, actual_ext, pad_mode, fade_length)
        all_f = torch.cat([frames_bchw, padding], dim=0).permute(0, 2, 3, 1)

        encoded = vae.encode(all_f[:, :, :, :3])
        vs = encoded["samples"] if isinstance(encoded, dict) else encoded

        if vs.dim() == 5:
            lt, hl, wl = vs.shape[2], vs.shape[3], vs.shape[4]
        else:
            lt, hl, wl = 1, vs.shape[-2], vs.shape[-1]

        ilt = frames_to_latent_count(actual_ctx)
        olt = frames_to_latent_count(max(overlap_frames, 1)) if overlap_frames > 0 else 0
        m1d = build_temporal_mask_1d(lt, ilt, olt, blend_mode)
        nm = m1d.view(1, lt, 1, 1).expand(1, lt, hl, wl).clone().to(device=vs.device, dtype=vs.dtype)

        vlat = {"samples": vs, "noise_mask": nm}

        alat = {"samples": torch.zeros(1, 64, lt, dtype=torch.float32, device=vs.device)}
        if prev_audio is not None and audio_vae is not None:
            try:
                ae = audio_vae.encode(prev_audio)
                alat = ae if isinstance(ae, dict) else {"samples": ae}
            except Exception as e:
                print(f"[LTXChain v3] Audio failed: {e}")

        return (vlat, alat, total_pix, actual_ctx, actual_ctx, fps)


# === NODE 3: LTXVideoOverlapBlend ===

class LTXVideoOverlapBlend:
    """Blends two decoded video segments at overlap boundary."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "segment_a": ("IMAGE",),
                "segment_b": ("IMAGE",),
                "overlap_frames": ("INT", {"default": 16, "min": 1, "max": 64, "step": 1}),
                "blend_mode": (["cosine", "linear", "sigmoid"], {"default": "cosine"}),
                "trim_b_start": ("INT", {"default": 0, "min": 0, "max": 128, "step": 1}),
            },
            "optional": {"audio_a": ("AUDIO",), "audio_b": ("AUDIO",)}
        }

    RETURN_TYPES = ("IMAGE", "AUDIO")
    RETURN_NAMES = ("blended_frames", "blended_audio")
    FUNCTION = "execute"
    CATEGORY = "video_models/ltx_extend"

    def execute(self, segment_a, segment_b, overlap_frames, blend_mode, trim_b_start, audio_a=None, audio_b=None):
        na = segment_a.shape[0]
        if trim_b_start > 0:
            segment_b = segment_b[trim_b_start:]
        nb = segment_b.shape[0]
        ov = min(overlap_frames, na, nb)

        if ov <= 0:
            return (torch.cat([segment_a, segment_b], dim=0), audio_b or audio_a)

        w = torch.zeros(ov, 1, 1, 1, dtype=torch.float32, device=segment_a.device)
        for i in range(ov):
            t = (i + 1) / (ov + 1)
            if blend_mode == "cosine":
                w[i] = 0.5 * (1.0 - math.cos(math.pi * t))
            elif blend_mode == "sigmoid":
                w[i] = 1.0 / (1.0 + math.exp(-12.0 * (t - 0.5)))
            else:
                w[i] = t

        blended = segment_a[na - ov:] * (1.0 - w) + segment_b[:ov] * w
        parts = []
        if na - ov > 0:
            parts.append(segment_a[:na - ov])
        parts.append(blended)
        if nb - ov > 0:
            parts.append(segment_b[ov:])

        return (torch.cat(parts, dim=0), audio_b or audio_a)


# === NODE 4: LTXVideoFrameInfo ===

class LTXVideoFrameInfo:
    """Utility: frame count info and 8k+1 validation."""

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "video_frames": ("IMAGE",),
            "fps": ("FLOAT", {"default": 24.0, "min": 1.0, "max": 60.0, "step": 1.0}),
            "desired_extension_seconds": ("FLOAT", {"default": 5.0, "min": 0.5, "max": 60.0, "step": 0.5}),
        }}

    RETURN_TYPES = ("INT", "INT", "INT", "INT", "FLOAT", "STRING")
    RETURN_NAMES = ("input_frames", "valid_total", "ext_frames", "latent_t", "ext_seconds", "info")
    FUNCTION = "execute"
    CATEGORY = "video_models/ltx_extend"

    def execute(self, video_frames, fps, desired_extension_seconds):
        n = video_frames.shape[0]
        h, w = video_frames.shape[1], video_frames.shape[2]
        de = max(1, int(desired_extension_seconds * fps))
        tv = snap_to_ltx_frame_count(n + de)
        ae = tv - n
        lt = frames_to_latent_count(tv)
        info = (f"Input: {n}f ({n/fps:.1f}s) | Ext: {ae}f ({ae/fps:.1f}s) | "
                f"Total: {tv}f ({tv/fps:.1f}s) | Latent T: {lt} | "
                f"Res: {snap_to_divisible(w,32)}x{snap_to_divisible(h,32)}")
        return (n, tv, ae, lt, ae / fps, info)


# === NODE 5: LTXVideoExtractTailFrames ===

class LTXVideoExtractTailFrames:
    """Extracts last N frames for chaining context."""

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "video_frames": ("IMAGE",),
            "tail_frames": ("INT", {"default": 33, "min": 1, "max": 256, "step": 1}),
            "snap_to_8k1": ("BOOLEAN", {"default": True}),
        }}

    RETURN_TYPES = ("IMAGE", "INT")
    RETURN_NAMES = ("tail_frames", "frame_count")
    FUNCTION = "execute"
    CATEGORY = "video_models/ltx_extend"

    def execute(self, video_frames, tail_frames, snap_to_8k1):
        total = video_frames.shape[0]
        n = min(tail_frames, total)
        if snap_to_8k1:
            n = min(snap_to_ltx_frame_count(n), total)
        return (video_frames[total - n:], video_frames[total - n:].shape[0])


# === REGISTRATION ===

NODE_CLASS_MAPPINGS = {
    "LTXVideoExtendFromReference": LTXVideoExtendFromReference,
    "LTXVideoChainExtension": LTXVideoChainExtension,
    "LTXVideoOverlapBlend": LTXVideoOverlapBlend,
    "LTXVideoFrameInfo": LTXVideoFrameInfo,
    "LTXVideoExtractTailFrames": LTXVideoExtractTailFrames,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "LTXVideoExtendFromReference": "LTX Video Extend From Reference v3",
    "LTXVideoChainExtension": "LTX Video Chain Extension v3",
    "LTXVideoOverlapBlend": "LTX Video Overlap Blend",
    "LTXVideoFrameInfo": "LTX Video Frame Info",
    "LTXVideoExtractTailFrames": "LTX Video Extract Tail Frames",
}
