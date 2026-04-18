/**
 * Studio Workflow Engine
 * Builds T2I and HireFix workflows for ComfyUI.
 */

import t2iBase from '../../workflow/T2I.json';
import qwenT2iBase from '../../workflow/QwenT2I.json';
import hiresBase from '../../workflow/HireFix.json';

// ─── T2I Node Map ────────────────────────────────────────────────────
export const T2I = {
  CHECKPOINT:  '5',
  KSAMPLER:    '7',
  PROMPT_POS:  '8',
  PROMPT_NEG:  '18',
  VAE_DECODE:  '13',
  PREVIEW:     '103',
  SEED:        '123',
  STEPS:       '122',
  CFG:         '121',
  BATCH_SIZE:  '127',
  RES_SWITCH:  '39',
  LAT_PORTRAIT:  '36',
  LAT_LANDSCAPE: '37',
  LAT_SQUARE:    '38',
};

// ─── Qwen T2I Node Map ──────────────────────────────────────────────
export const QWEN_T2I = {
  UNET:       '92',  // UNETLoader
  CLIP:       '89',  // CLIPLoader
  VAE:        '88',  // VAELoader
  PROMPT_POS: '93',  // CLIPTextEncode
  PROMPT_NEG: '94',  // CLIPTextEncode
  LATENT:     '90',  // EmptySD3LatentImage (width, height, batch_size)
  SHIFT:      '91',  // ModelSamplingAuraFlow
  SAMPLER:    '97',  // KSampler
  VAE_DECODE: '95',  // VAEDecode
  SAVE:       '60',  // SaveImage
  SEED:       '108', // Seed (rgthree)
};

// ─── HireFix Node Map (Qwen Edit) ───────────────────────────
export const HIRES = {
  LOAD_IMAGE:    '160',
  CHECKPOINT:    '149',
  PROMPT_POS:    '158', // TextEncodeQwenImageEditPlus
  PROMPT_NEG:    '151', // TextEncodeQwenImageEditPlus
  KSAMPLER:      '157',
  VAE_ENCODE:    '172',
  VAE_DECODE:    '148',
  UPSCALE_IMG:   '176', // ImageUpscaleWithModel
  UPSCALE_MODEL: '177', // UpscaleModelLoader
  UPSCALE_BY:    '188', // easy float (scale factor)
  DOWNSCALE:     '180', // ImageScale (to target size)
  GET_SIZE:      '182',
  PREVIEW:       '190',
};

export const STUDIO_RESOLUTIONS = {
  portrait:  { label: 'Portrait',  w: 832,  h: 1216, switchVal: 3 },
  square:    { label: 'Square',    w: 1024, h: 1024, switchVal: 1 },
  landscape: { label: 'Landscape', w: 1216, h: 832,  switchVal: 2 },
};

function deepCopy(obj) { return JSON.parse(JSON.stringify(obj)); }

function nextNodeId(wf) {
  let max = 0;
  for (const id of Object.keys(wf)) {
    const n = parseInt(id, 10);
    if (!isNaN(n) && n > max) max = n;
  }
  return max + 1;
}

/**
 * Inject LoRAs using full LoraLoader (model + clip).
 * Rewires all downstream nodes that reference the checkpoint's MODEL(0) and CLIP(1).
 */
function injectLoras(wf, ckptNodeId, loras) {
  if (!loras || loras.length === 0) return wf;

  // Find all nodes referencing checkpoint outputs 0 (model) and 1 (clip)
  const downstream = {};
  for (const [nid, node] of Object.entries(wf)) {
    if (nid === ckptNodeId) continue;
    for (const [inputName, val] of Object.entries(node.inputs || {})) {
      if (Array.isArray(val) && val.length === 2 && String(val[0]) === String(ckptNodeId) && (val[1] === 0 || val[1] === 1)) {
        if (!downstream[nid]) downstream[nid] = {};
        downstream[nid][inputName] = val[1]; // 0=model, 1=clip
      }
    }
  }

  // Build LoRA chain
  let currentId = nextNodeId(wf);
  let prevModel = [ckptNodeId, 0];
  let prevClip = [ckptNodeId, 1];

  for (const lora of loras) {
    const lid = String(currentId);
    wf[lid] = {
      class_type: 'LoraLoader',
      inputs: {
        lora_name: lora.name,
        strength_model: lora.strength ?? 1.0,
        strength_clip: lora.strength ?? 1.0,
        model: [prevModel[0], prevModel[1]],
        clip: [prevClip[0], prevClip[1]],
      },
    };
    prevModel = [lid, 0];
    prevClip = [lid, 1];
    currentId++;
  }

  // Rewire downstream
  for (const [nid, refs] of Object.entries(downstream)) {
    for (const [inputName, outputIdx] of Object.entries(refs)) {
      if (outputIdx === 0) wf[nid].inputs[inputName] = [prevModel[0], prevModel[1]];
      else if (outputIdx === 1) wf[nid].inputs[inputName] = [prevClip[0], prevClip[1]];
    }
  }

  return wf;
}

/**
 * Build T2I workflow.
 */
export function buildT2I({ prompt, negPrompt, resolution, seed, steps, cfg, batchSize, loras, checkpoint }) {
  const wf = deepCopy(t2iBase);

  // Prompt
  wf[T2I.PROMPT_POS].inputs.text = prompt || '';
  wf[T2I.PROMPT_NEG].inputs.text = negPrompt || '';

  // Resolution
  const res = STUDIO_RESOLUTIONS[resolution] || STUDIO_RESOLUTIONS.square;
  wf[T2I.RES_SWITCH].inputs.selection_setting = res.switchVal;

  // Seed
  wf[T2I.SEED].inputs.value = seed ?? 0;

  // Steps, CFG
  if (steps) wf[T2I.STEPS].inputs.value = steps;
  if (cfg) wf[T2I.CFG].inputs.value = cfg;

  // Batch size
  wf[T2I.BATCH_SIZE].inputs.value = batchSize || 1;

  // Checkpoint
  if (checkpoint) wf[T2I.CHECKPOINT].inputs.ckpt_name = checkpoint;

  // LoRA injection
  const enabled = (loras || []).filter(l => l.enabled !== false);
  injectLoras(wf, T2I.CHECKPOINT, enabled);

  return wf;
}

/**
 * Inject LoRAs for workflows with separate model (UNET) and clip (CLIP) nodes.
 * Chains LoraLoader between the two source nodes and their downstream consumers.
 */
function injectLorasSplit(wf, modelNodeId, modelSlot, clipNodeId, clipSlot, loras) {
  if (!loras || loras.length === 0) return wf;

  // Find all downstream references to model and clip
  const modelDownstream = {}; // { nodeId: inputName }
  const clipDownstream = {};
  for (const [nid, node] of Object.entries(wf)) {
    if (nid === modelNodeId || nid === clipNodeId) continue;
    for (const [inputName, val] of Object.entries(node.inputs || {})) {
      if (Array.isArray(val) && val.length === 2) {
        if (String(val[0]) === String(modelNodeId) && val[1] === modelSlot) modelDownstream[nid] = inputName;
        if (String(val[0]) === String(clipNodeId) && val[1] === clipSlot) clipDownstream[nid] = inputName;
      }
    }
  }

  let currentId = nextNodeId(wf);
  let prevModel = [String(modelNodeId), modelSlot];
  let prevClip = [String(clipNodeId), clipSlot];

  for (const lora of loras) {
    const lid = String(currentId);
    wf[lid] = {
      class_type: 'LoraLoader',
      inputs: {
        lora_name: lora.name,
        strength_model: lora.strength ?? 1.0,
        strength_clip: lora.strength ?? 1.0,
        model: [prevModel[0], prevModel[1]],
        clip: [prevClip[0], prevClip[1]],
      },
    };
    prevModel = [lid, 0];
    prevClip = [lid, 1];
    currentId++;
  }

  // Rewire downstream
  for (const [nid, inputName] of Object.entries(modelDownstream)) {
    wf[nid].inputs[inputName] = [prevModel[0], prevModel[1]];
  }
  for (const [nid, inputName] of Object.entries(clipDownstream)) {
    wf[nid].inputs[inputName] = [prevClip[0], prevClip[1]];
  }

  return wf;
}

// ─── Qwen T2I Resolutions (direct width/height, no switch nodes) ──
export const QWEN_RESOLUTIONS = {
  portrait:  { label: 'Portrait',  w: 896,  h: 1328 },
  square:    { label: 'Square',    w: 1328, h: 1328 },
  landscape: { label: 'Landscape', w: 1328, h: 896 },
};

/**
 * Build Qwen T2I workflow.
 * Uses UNETLoader + CLIPLoader + VAELoader (separate model loading).
 * Resolution set directly via width/height on EmptySD3LatentImage.
 */
export function buildQwenT2I({ prompt, negPrompt, resolution, seed, steps, cfg, shift, batchSize, loras, unet, clip, vae }) {
  const wf = deepCopy(qwenT2iBase);

  // Prompt
  wf[QWEN_T2I.PROMPT_POS].inputs.text = prompt || '';
  wf[QWEN_T2I.PROMPT_NEG].inputs.text = negPrompt || '';

  // Resolution — direct width/height on latent node
  const res = QWEN_RESOLUTIONS[resolution] || QWEN_RESOLUTIONS.square;
  wf[QWEN_T2I.LATENT].inputs.width = res.w;
  wf[QWEN_T2I.LATENT].inputs.height = res.h;
  wf[QWEN_T2I.LATENT].inputs.batch_size = batchSize || 1;

  // Seed
  wf[QWEN_T2I.SEED].inputs.seed = seed ?? Math.floor(Math.random() * 2147483647);

  // Sampler settings
  if (steps) wf[QWEN_T2I.SAMPLER].inputs.steps = steps;
  if (cfg) wf[QWEN_T2I.SAMPLER].inputs.cfg = cfg;

  // Shift (ModelSamplingAuraFlow)
  if (shift != null) wf[QWEN_T2I.SHIFT].inputs.shift = shift;

  // Models
  if (unet) wf[QWEN_T2I.UNET].inputs.unet_name = unet;
  if (clip) wf[QWEN_T2I.CLIP].inputs.clip_name = clip;
  if (vae) wf[QWEN_T2I.VAE].inputs.vae_name = vae;

  // LoRA injection (split model/clip sources)
  const enabled = (loras || []).filter(l => l.enabled !== false);
  injectLorasSplit(wf, QWEN_T2I.UNET, 0, QWEN_T2I.CLIP, 0, enabled);

  return wf;
}

/**
 * Build HireFix workflow (Qwen Edit).
 * Fast mode:    4 steps, CFG 1 (neg prompt disabled), quick enhancement
 * Quality mode: 15 steps, CFG 3.5 (neg prompt active), detailed enhancement
 */
export function buildHireFix({ imageName, prompt, negPrompt, upscaleBy, denoise, mode, checkpoint, upscaleModel }) {
  const wf = deepCopy(hiresBase);
  const isFast = mode === 'fast';

  // Input image
  wf[HIRES.LOAD_IMAGE].inputs.image = imageName;

  // Qwen Edit prompt (image-aware encoding)
  if (prompt) wf[HIRES.PROMPT_POS].inputs.prompt = prompt;
  if (negPrompt && !isFast) wf[HIRES.PROMPT_NEG].inputs.prompt = negPrompt;

  // KSampler — mode-based settings
  wf[HIRES.KSAMPLER].inputs.steps = isFast ? 4 : 15;
  wf[HIRES.KSAMPLER].inputs.cfg = isFast ? 1 : 3.5;
  if (denoise !== undefined) wf[HIRES.KSAMPLER].inputs.denoise = denoise;
  wf[HIRES.KSAMPLER].inputs.seed = Math.floor(Math.random() * 2147483647);

  // Upscale factor (default 1.15)
  if (upscaleBy) wf[HIRES.UPSCALE_BY].inputs.value = upscaleBy;

  // Checkpoint (Qwen Edit model)
  if (checkpoint) wf[HIRES.CHECKPOINT].inputs.ckpt_name = checkpoint;

  // Upscale model
  if (upscaleModel) wf[HIRES.UPSCALE_MODEL].inputs.model_name = upscaleModel;

  return wf;
}
