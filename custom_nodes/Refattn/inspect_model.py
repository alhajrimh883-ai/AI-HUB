"""
Model Inspection Script for RefAttn
====================================

Run this to discover the attention layer structure of your Wan 2.2 checkpoint.
The output tells you what patterns to use in _is_self_attention().

Usage:
    python inspect_model.py --model /path/to/wan22.safetensors

    # Or if model is already loaded in ComfyUI, run from ComfyUI's Python:
    python inspect_model.py --comfyui
"""

import argparse
import sys


def inspect_from_file(model_path: str):
    """Load a checkpoint and inspect its structure."""
    import torch

    print(f"\nLoading model from: {model_path}")
    print("=" * 80)

    # Try loading as safetensors first
    if model_path.endswith(".safetensors"):
        try:
            from safetensors.torch import load_file
            state_dict = load_file(model_path)
        except ImportError:
            print("safetensors not installed, trying torch.load...")
            state_dict = torch.load(model_path, map_location="cpu")
    else:
        state_dict = torch.load(model_path, map_location="cpu")

    if isinstance(state_dict, dict) and "state_dict" in state_dict:
        state_dict = state_dict["state_dict"]

    # Analyze key patterns
    print("\n--- All unique key prefixes (depth=3) ---")
    prefixes = set()
    for key in state_dict.keys():
        parts = key.split(".")
        for depth in range(1, min(4, len(parts) + 1)):
            prefixes.add(".".join(parts[:depth]))

    for prefix in sorted(prefixes):
        count = sum(1 for k in state_dict if k.startswith(prefix + ".") or k == prefix)
        if count > 0:
            print(f"  {prefix} ({count} params)")

    # Find attention-related keys
    print("\n--- Attention-related keys ---")
    attn_keywords = ["attn", "attention", "self_attn", "cross_attn", "qkv", "to_q", "to_k", "to_v"]
    attn_keys = [k for k in state_dict.keys() if any(kw in k.lower() for kw in attn_keywords)]

    if not attn_keys:
        print("  No attention keys found! The model may use different naming.")
        print("  All keys containing 'q', 'k', or 'v':")
        for k in sorted(state_dict.keys()):
            parts = k.split(".")
            if any(p in ["q", "k", "v", "qkv", "query", "key", "value"] for p in parts):
                print(f"    {k} shape={state_dict[k].shape}")
    else:
        # Group by block
        blocks = {}
        for k in sorted(attn_keys):
            # Extract block identifier (e.g., "blocks.0", "transformer_blocks.5")
            parts = k.split(".")
            block_id = ".".join(parts[:2]) if len(parts) > 2 else parts[0]
            if block_id not in blocks:
                blocks[block_id] = []
            blocks[block_id].append(k)

        for block_id, keys in sorted(blocks.items()):
            print(f"\n  [{block_id}]")
            for k in keys:
                shape = state_dict[k].shape
                print(f"    {k}  {shape}")

    # Identify self-attention vs cross-attention
    print("\n--- Suggested _is_self_attention() patterns ---")
    self_attn_patterns = set()
    cross_attn_patterns = set()

    for k in attn_keys:
        if "self" in k.lower() or "attn1" in k.lower():
            # Extract the module path (everything before .weight/.bias)
            module_path = ".".join(k.split(".")[:-1])
            self_attn_patterns.add(module_path)
        elif "cross" in k.lower() or "attn2" in k.lower():
            module_path = ".".join(k.split(".")[:-1])
            cross_attn_patterns.add(module_path)

    if self_attn_patterns:
        print("\n  Self-attention modules (HOOK THESE):")
        for p in sorted(self_attn_patterns)[:10]:
            print(f"    {p}")
        if len(self_attn_patterns) > 10:
            print(f"    ... and {len(self_attn_patterns) - 10} more")

        # Suggest pattern
        example = sorted(self_attn_patterns)[0]
        parts = example.split(".")
        # Find the varying part (usually a number)
        pattern_parts = []
        for p in parts:
            if p.isdigit():
                pattern_parts.append("N")
            else:
                pattern_parts.append(p)
        pattern = ".".join(pattern_parts)
        print(f"\n  Suggested pattern: \"{pattern}\"")
        print(f"  Match with: 'attn1' in name or 'self_attn' in name")

    if cross_attn_patterns:
        print("\n  Cross-attention modules (DO NOT HOOK):")
        for p in sorted(cross_attn_patterns)[:5]:
            print(f"    {p}")

    if not self_attn_patterns and not cross_attn_patterns:
        print("\n  Could not auto-detect self vs cross attention.")
        print("  You'll need to manually inspect the model and update")
        print("  _is_self_attention() in core/feature_extraction.py")
        print("\n  Look for modules with Q/K/V projections.")
        print("  Self-attention: Q, K, V all come from the same input")
        print("  Cross-attention: Q comes from one input, K/V from another")

    print("\n" + "=" * 80)
    print("Done. Update _is_self_attention() in core/feature_extraction.py")
    print("with the patterns found above.\n")


def inspect_comfyui():
    """Inspect a model already loaded in ComfyUI."""
    print("\nComfyUI inspection mode")
    print("Run this inside ComfyUI's Python environment:")
    print()
    print("  import comfy")
    print("  # After loading your model in the workflow, find it:")
    print("  # model = <your loaded model>")
    print("  dit = model.model.diffusion_model")
    print("  for name, mod in dit.named_modules():")
    print("      if hasattr(mod, 'to_q') or hasattr(mod, 'qkv'):")
    print("          print(f'{name}: {type(mod).__name__}')")
    print()
    print("  # This shows all attention layers.")
    print("  # Self-attn usually has 'attn1' or 'self_attn' in the name.")
    print("  # Cross-attn usually has 'attn2' or 'cross_attn' in the name.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Inspect Wan 2.2 model structure for RefAttn")
    parser.add_argument("--model", type=str, help="Path to model checkpoint")
    parser.add_argument("--comfyui", action="store_true", help="Show ComfyUI inspection instructions")

    args = parser.parse_args()

    if args.comfyui:
        inspect_comfyui()
    elif args.model:
        inspect_from_file(args.model)
    else:
        parser.print_help()
        print("\nExample:")
        print("  python inspect_model.py --model /path/to/wan22_dit.safetensors")
