// Unit tests for src/lib/studioWorkflow.js — buildT2I, buildQwenT2I, buildHireFix.
// These builders take parameters and produce ComfyUI workflow JSON. If node IDs,
// resolution handling, or LoRA injection silently regress, Studio generation
// breaks with no error — exactly the kind of bug tests exist to catch.

import { describe, it, expect } from 'vitest';
import {
  buildT2I,
  buildQwenT2I,
  buildHireFix,
  T2I,
  QWEN_T2I,
  HIRES,
  STUDIO_RESOLUTIONS,
  QWEN_RESOLUTIONS,
} from '../src/lib/studioWorkflow.js';

// ─── buildT2I (SDXL family) ──────────────────────────────────────────

describe('buildT2I', () => {
  const base = {
    prompt: 'a test prompt',
    negPrompt: 'bad stuff',
    resolution: 'portrait',
    seed: 42,
    steps: 20,
    cfg: 7,
    batchSize: 2,
    checkpoint: 'sdxl_test.safetensors',
  };

  it('sets positive and negative prompts on the correct nodes', () => {
    const wf = buildT2I(base);
    expect(wf[T2I.PROMPT_POS].inputs.text).toBe('a test prompt');
    expect(wf[T2I.PROMPT_NEG].inputs.text).toBe('bad stuff');
  });

  it('maps resolution names to the correct switch value', () => {
    const portrait = buildT2I({ ...base, resolution: 'portrait' });
    const square = buildT2I({ ...base, resolution: 'square' });
    const landscape = buildT2I({ ...base, resolution: 'landscape' });
    expect(portrait[T2I.RES_SWITCH].inputs.selection_setting).toBe(STUDIO_RESOLUTIONS.portrait.switchVal);
    expect(square[T2I.RES_SWITCH].inputs.selection_setting).toBe(STUDIO_RESOLUTIONS.square.switchVal);
    expect(landscape[T2I.RES_SWITCH].inputs.selection_setting).toBe(STUDIO_RESOLUTIONS.landscape.switchVal);
  });

  it('falls back to square when resolution is unknown', () => {
    const wf = buildT2I({ ...base, resolution: 'bogus' });
    expect(wf[T2I.RES_SWITCH].inputs.selection_setting).toBe(STUDIO_RESOLUTIONS.square.switchVal);
  });

  it('sets seed, steps, cfg, batch size, and checkpoint', () => {
    const wf = buildT2I(base);
    expect(wf[T2I.SEED].inputs.value).toBe(42);
    expect(wf[T2I.STEPS].inputs.value).toBe(20);
    expect(wf[T2I.CFG].inputs.value).toBe(7);
    expect(wf[T2I.BATCH_SIZE].inputs.value).toBe(2);
    expect(wf[T2I.CHECKPOINT].inputs.ckpt_name).toBe('sdxl_test.safetensors');
  });

  it('defaults batch size to 1 when omitted', () => {
    const { batchSize, ...rest } = base;
    const wf = buildT2I(rest);
    expect(wf[T2I.BATCH_SIZE].inputs.value).toBe(1);
  });

  it('does not add LoraLoader nodes when no LoRAs provided', () => {
    const wf = buildT2I(base);
    const loraNodes = Object.values(wf).filter(n => n.class_type === 'LoraLoader');
    expect(loraNodes.length).toBe(0);
  });

  it('injects a LoraLoader chain when LoRAs are provided', () => {
    const wf = buildT2I({
      ...base,
      loras: [
        { name: 'style.safetensors', strength: 0.8 },
        { name: 'detail.safetensors', strength: 0.5 },
      ],
    });
    const loraNodes = Object.values(wf).filter(n => n.class_type === 'LoraLoader');
    expect(loraNodes.length).toBe(2);
    const names = loraNodes.map(n => n.inputs.lora_name);
    expect(names).toContain('style.safetensors');
    expect(names).toContain('detail.safetensors');
    const style = loraNodes.find(n => n.inputs.lora_name === 'style.safetensors');
    expect(style.inputs.strength_model).toBe(0.8);
    expect(style.inputs.strength_clip).toBe(0.8);
  });

  it('skips LoRAs explicitly disabled', () => {
    const wf = buildT2I({
      ...base,
      loras: [
        { name: 'on.safetensors', strength: 1, enabled: true },
        { name: 'off.safetensors', strength: 1, enabled: false },
      ],
    });
    const names = Object.values(wf).filter(n => n.class_type === 'LoraLoader').map(n => n.inputs.lora_name);
    expect(names).toContain('on.safetensors');
    expect(names).not.toContain('off.safetensors');
  });

  it('rewires downstream checkpoint consumers to the last LoRA in the chain', () => {
    const wf = buildT2I({
      ...base,
      loras: [{ name: 'a.safetensors', strength: 1 }],
    });
    // The KSampler's model input should no longer point at the checkpoint directly
    // when a LoRA chain exists — it should be rewired to the LoraLoader's output.
    const kModel = wf[T2I.KSAMPLER].inputs.model;
    expect(Array.isArray(kModel)).toBe(true);
    expect(String(kModel[0])).not.toBe(T2I.CHECKPOINT);
  });
});

// ─── buildQwenT2I (Qwen family) ──────────────────────────────────────

describe('buildQwenT2I', () => {
  const base = {
    prompt: 'qwen prompt',
    negPrompt: 'qwen neg',
    resolution: 'landscape',
    seed: 123,
    steps: 8,
    cfg: 4,
    shift: 3.2,
    batchSize: 1,
    unet: 'qwen_unet.safetensors',
    clip: 'qwen_clip.safetensors',
    vae: 'qwen_vae.safetensors',
  };

  it('sets prompts on Qwen CLIP encode nodes', () => {
    const wf = buildQwenT2I(base);
    expect(wf[QWEN_T2I.PROMPT_POS].inputs.text).toBe('qwen prompt');
    expect(wf[QWEN_T2I.PROMPT_NEG].inputs.text).toBe('qwen neg');
  });

  it('sets width and height directly on the latent node', () => {
    const wf = buildQwenT2I(base);
    expect(wf[QWEN_T2I.LATENT].inputs.width).toBe(QWEN_RESOLUTIONS.landscape.w);
    expect(wf[QWEN_T2I.LATENT].inputs.height).toBe(QWEN_RESOLUTIONS.landscape.h);
  });

  it('falls back to square resolution when unknown', () => {
    const wf = buildQwenT2I({ ...base, resolution: 'nope' });
    expect(wf[QWEN_T2I.LATENT].inputs.width).toBe(QWEN_RESOLUTIONS.square.w);
    expect(wf[QWEN_T2I.LATENT].inputs.height).toBe(QWEN_RESOLUTIONS.square.h);
  });

  it('sets unet, clip, vae, shift, steps, cfg', () => {
    const wf = buildQwenT2I(base);
    expect(wf[QWEN_T2I.UNET].inputs.unet_name).toBe('qwen_unet.safetensors');
    expect(wf[QWEN_T2I.CLIP].inputs.clip_name).toBe('qwen_clip.safetensors');
    expect(wf[QWEN_T2I.VAE].inputs.vae_name).toBe('qwen_vae.safetensors');
    expect(wf[QWEN_T2I.SHIFT].inputs.shift).toBe(3.2);
    expect(wf[QWEN_T2I.SAMPLER].inputs.steps).toBe(8);
    expect(wf[QWEN_T2I.SAMPLER].inputs.cfg).toBe(4);
  });

  it('sets seed on Qwen seed node', () => {
    const wf = buildQwenT2I(base);
    expect(wf[QWEN_T2I.SEED].inputs.seed).toBe(123);
  });

  it('injects LoRAs with split model/clip sources', () => {
    const wf = buildQwenT2I({
      ...base,
      loras: [{ name: 'qwen_lora.safetensors', strength: 0.75 }],
    });
    const loraNodes = Object.values(wf).filter(n => n.class_type === 'LoraLoader');
    expect(loraNodes.length).toBe(1);
    expect(loraNodes[0].inputs.lora_name).toBe('qwen_lora.safetensors');
    expect(loraNodes[0].inputs.strength_model).toBe(0.75);
    // Chain root for model should be the UNET node, for clip should be the CLIP node
    const lora = loraNodes[0];
    expect(String(lora.inputs.model[0])).toBe(QWEN_T2I.UNET);
    expect(String(lora.inputs.clip[0])).toBe(QWEN_T2I.CLIP);
  });
});

// ─── buildHireFix ────────────────────────────────────────────────────

describe('buildHireFix', () => {
  const base = {
    imageName: 'input.png',
    prompt: 'enhance',
    negPrompt: 'blurry',
    upscaleBy: 1.5,
    denoise: 0.35,
    checkpoint: 'qwen_edit.safetensors',
    upscaleModel: 'upscale.pth',
  };

  it('sets input image name', () => {
    const wf = buildHireFix({ ...base, mode: 'fast' });
    expect(wf[HIRES.LOAD_IMAGE].inputs.image).toBe('input.png');
  });

  it('fast mode: 4 steps, CFG 1, skips negative prompt', () => {
    const wf = buildHireFix({ ...base, mode: 'fast' });
    expect(wf[HIRES.KSAMPLER].inputs.steps).toBe(4);
    expect(wf[HIRES.KSAMPLER].inputs.cfg).toBe(1);
    // Neg prompt input.prompt should NOT have been overwritten to our negPrompt
    expect(wf[HIRES.PROMPT_NEG].inputs.prompt).not.toBe('blurry');
  });

  it('quality mode: 15 steps, CFG 3.5, applies negative prompt', () => {
    const wf = buildHireFix({ ...base, mode: 'quality' });
    expect(wf[HIRES.KSAMPLER].inputs.steps).toBe(15);
    expect(wf[HIRES.KSAMPLER].inputs.cfg).toBe(3.5);
    expect(wf[HIRES.PROMPT_NEG].inputs.prompt).toBe('blurry');
  });

  it('sets denoise when provided', () => {
    const wf = buildHireFix({ ...base, mode: 'quality' });
    expect(wf[HIRES.KSAMPLER].inputs.denoise).toBe(0.35);
  });

  it('sets upscale factor and model when provided', () => {
    const wf = buildHireFix({ ...base, mode: 'fast' });
    expect(wf[HIRES.UPSCALE_BY].inputs.value).toBe(1.5);
    expect(wf[HIRES.UPSCALE_MODEL].inputs.model_name).toBe('upscale.pth');
  });

  it('sets checkpoint name', () => {
    const wf = buildHireFix({ ...base, mode: 'fast' });
    expect(wf[HIRES.CHECKPOINT].inputs.ckpt_name).toBe('qwen_edit.safetensors');
  });
});
