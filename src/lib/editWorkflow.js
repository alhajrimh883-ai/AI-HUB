/**
 * Edit + HireFix Workflow Builders
 * Handles Qwen Edit, Qwen HireFix, and SDXL HireFix workflows.
 */
import editBase from '../../workflow/Edit.json';
import hirefixQwenBase from '../../workflow/HireFix-Qwen.json';
import hirefixSdxlBase from '../../workflow/HireFix-SDXL.json';

function deepCopy(obj) { return JSON.parse(JSON.stringify(obj)); }

// ── Edit (Qwen) Node IDs ──
const EDIT = {
  LOAD_IMAGE:     '78',
  LOAD_IMAGE_2:   '480',   // optional
  LOAD_IMAGE_3:   '481',   // optional
  SAVE_IMAGE:     '60',
  STEPS:          '485',
  CFG:            '486',
  CHECKPOINT:     '487',
  CLIP:           '488',
  VAE:            '489',
  SHIFT:          '490',   // ModelSamplingAuraFlow
  KSAMPLER:       '492',
  SWITCH_SD:      '499',   // ThreeWaySwitch (480p: portrait=1, square=2, landscape=3)
  SWITCH_HD:      '500',   // ThreeWaySwitch (720p)
  SWITCH_RES:     '501',   // ComfySwitchNode (false=SD, true=HD)
  POS_PROMPT:     '502',   // TextEncodeQwenImageEditPlus
  NEG_PROMPT:     '503',
};

// ── HireFix (Qwen) Node IDs ──
const HFQ = {
  LOAD_IMAGE:     '78',
  SAVE_IMAGE:     '342',
  STEPS:          '477',
  CFG:            '478',
  CHECKPOINT:     '481',
  CLIP:           '482',
  VAE:            '483',
  SHIFT:          '472',   // ModelSamplingAuraFlow
  KSAMPLER:       '484',
  POS_PROMPT:     '471',
  NEG_PROMPT:     '473',
  UPSCALE_BY:     '492',
  UPSCALE_MODEL:  '495',
};

// ── HireFix (SDXL) Node IDs ──
const HFS = {
  LOAD_IMAGE:     '55',
  SAVE_IMAGE:     '9',
  CHECKPOINT:     '4',
  POS_PROMPT:     '16',
  NEG_PROMPT:     '40',
  KSAMPLER:       '3',
  UPSCALE_BY:     '69',
  UPSCALE_MODEL:  '60',
};

// ── Resolution mapping for Edit workflow ──
// ThreeWaySwitch: 1=portrait, 2=square, 3=landscape
function getResSwitch(resolution) {
  if (resolution === 'portrait') return 1;
  if (resolution === 'landscape') return 3;
  return 2; // square default
}

/**
 * Build Qwen Edit workflow
 * @param {Object} params
 * @param {string} params.imageName — uploaded to ComfyUI
 * @param {string} params.editPrompt — what to edit
 * @param {string} [params.negPrompt] — negative prompt
 * @param {string} [params.image2Name] — optional 2nd image
 * @param {string} [params.image3Name] — optional 3rd image
 * @param {string} [params.resolution] — portrait/square/landscape
 * @param {boolean} [params.highRes] — false=480p, true=720p
 * @param {string} [params.checkpoint]
 * @param {string} [params.clipModel]
 * @param {string} [params.vaeModel]
 * @param {number} [params.steps]
 * @param {number} [params.cfg]
 * @param {number} [params.shift]
 * @param {number} [params.seed]
 * @param {Array} [params.loras] — [{name, strength}]
 */
export function buildEdit(params) {
  const wf = deepCopy(editBase);

  // Main image
  wf[EDIT.LOAD_IMAGE].inputs.image = params.imageName;

  // Optional images — remove nodes if not provided
  if (params.image2Name) {
    wf[EDIT.LOAD_IMAGE_2].inputs.image = params.image2Name;
  } else {
    // Remove node 480 and disconnect from prompt encoders
    delete wf[EDIT.LOAD_IMAGE_2];
    // Remove image2 input from pos/neg prompt nodes
    delete wf[EDIT.POS_PROMPT].inputs.image2;
    delete wf[EDIT.NEG_PROMPT].inputs.image2;
  }

  if (params.image3Name) {
    wf[EDIT.LOAD_IMAGE_3].inputs.image = params.image3Name;
  } else {
    delete wf[EDIT.LOAD_IMAGE_3];
    delete wf[EDIT.POS_PROMPT].inputs.image3;
    delete wf[EDIT.NEG_PROMPT].inputs.image3;
  }

  // Prompts
  wf[EDIT.POS_PROMPT].inputs.prompt = params.editPrompt || '';
  wf[EDIT.NEG_PROMPT].inputs.prompt = params.negPrompt || '';

  // Resolution
  const resSetting = getResSwitch(params.resolution || 'square');
  wf[EDIT.SWITCH_SD].inputs.selection_setting = resSetting;
  wf[EDIT.SWITCH_HD].inputs.selection_setting = resSetting;
  wf[EDIT.SWITCH_RES].inputs.switch = params.highRes || false;

  // Models
  if (params.checkpoint) wf[EDIT.CHECKPOINT].inputs.ckpt_name = params.checkpoint;
  if (params.clipModel) wf[EDIT.CLIP].inputs.clip_name = params.clipModel;
  if (params.vaeModel) wf[EDIT.VAE].inputs.vae_name = params.vaeModel;

  // Settings
  if (params.steps) wf[EDIT.STEPS].inputs.value = params.steps;
  if (params.cfg) wf[EDIT.CFG].inputs.value = params.cfg;
  if (params.shift) wf[EDIT.SHIFT].inputs.shift = params.shift;

  // Seed
  wf[EDIT.KSAMPLER].inputs.seed = params.seed ?? Math.floor(Math.random() * 2 ** 53);

  // LoRA injection — between CFGNorm(491) and KSampler(492)
  if (params.loras?.length) {
    let prevModel = ['491', 0]; // CFGNorm output
    for (let i = 0; i < params.loras.length; i++) {
      const loraId = `edit_lora_${i}`;
      wf[loraId] = {
        inputs: {
          lora_name: params.loras[i].name,
          strength_model: params.loras[i].strength ?? 1,
          model: prevModel,
        },
        class_type: 'LoraLoaderModelOnly',
        _meta: { title: `Edit LoRA ${i + 1}` },
      };
      prevModel = [loraId, 0];
    }
    wf[EDIT.KSAMPLER].inputs.model = prevModel;
  }

  return wf;
}

/**
 * Build Qwen HireFix workflow
 */
export function buildHirefixQwen(params) {
  const wf = deepCopy(hirefixQwenBase);

  wf[HFQ.LOAD_IMAGE].inputs.image = params.imageName;
  wf[HFQ.POS_PROMPT].inputs.prompt = params.editPrompt || '';
  wf[HFQ.NEG_PROMPT].inputs.prompt = params.negPrompt || '';

  if (params.checkpoint) wf[HFQ.CHECKPOINT].inputs.ckpt_name = params.checkpoint;
  if (params.clipModel) wf[HFQ.CLIP].inputs.clip_name = params.clipModel;
  if (params.vaeModel) wf[HFQ.VAE].inputs.vae_name = params.vaeModel;

  if (params.steps) wf[HFQ.STEPS].inputs.value = params.steps;
  if (params.cfg) wf[HFQ.CFG].inputs.value = params.cfg;
  if (params.shift) wf[HFQ.SHIFT].inputs.shift = params.shift;
  if (params.denoise !== undefined) wf[HFQ.KSAMPLER].inputs.denoise = params.denoise;
  if (params.upscaleBy) wf[HFQ.UPSCALE_BY].inputs.value = params.upscaleBy;
  if (params.upscaleModel) wf[HFQ.UPSCALE_MODEL].inputs.model_name = params.upscaleModel;

  wf[HFQ.KSAMPLER].inputs.seed = params.seed ?? Math.floor(Math.random() * 2 ** 53);

  // LoRA injection — between CFGNorm(470) and KSampler(484)
  if (params.loras?.length) {
    let prevModel = ['470', 0];
    for (let i = 0; i < params.loras.length; i++) {
      const loraId = `hfq_lora_${i}`;
      wf[loraId] = {
        inputs: {
          lora_name: params.loras[i].name,
          strength_model: params.loras[i].strength ?? 1,
          model: prevModel,
        },
        class_type: 'LoraLoaderModelOnly',
        _meta: { title: `HireFix LoRA ${i + 1}` },
      };
      prevModel = [loraId, 0];
    }
    wf[HFQ.KSAMPLER].inputs.model = prevModel;
  }

  return wf;
}

/**
 * Build SDXL HireFix workflow
 * Uses image metadata for model/CFG/prompts, falls back to preset values.
 */
export function buildHirefixSdxl(params) {
  const wf = deepCopy(hirefixSdxlBase);

  wf[HFS.LOAD_IMAGE].inputs.image = params.imageName;

  // Model: image metadata → preset backup → workflow default
  if (params.checkpoint) wf[HFS.CHECKPOINT].inputs.ckpt_name = params.checkpoint;

  // Prompts: from image metadata
  wf[HFS.POS_PROMPT].inputs.text = params.positivePrompt || '';
  wf[HFS.NEG_PROMPT].inputs.text = params.negPrompt || '';

  // Steps from preset, CFG from image metadata or preset fallback
  if (params.steps) wf[HFS.KSAMPLER].inputs.steps = params.steps;
  if (params.cfg) wf[HFS.KSAMPLER].inputs.cfg = params.cfg;
  if (params.denoise !== undefined) wf[HFS.KSAMPLER].inputs.denoise = params.denoise;
  if (params.upscaleBy) wf[HFS.UPSCALE_BY].inputs.value = params.upscaleBy;
  if (params.upscaleModel) wf[HFS.UPSCALE_MODEL].inputs.model_name = params.upscaleModel;

  wf[HFS.KSAMPLER].inputs.seed = params.seed ?? Math.floor(Math.random() * 2 ** 53);

  // LoRA injection — between Checkpoint(4) model output and KSampler(3)
  if (params.loras?.length) {
    let prevModel = ['4', 0];
    for (let i = 0; i < params.loras.length; i++) {
      const loraId = `hfs_lora_${i}`;
      wf[loraId] = {
        inputs: {
          lora_name: params.loras[i].name,
          strength_model: params.loras[i].strength ?? 1,
          model: prevModel,
        },
        class_type: 'LoraLoaderModelOnly',
        _meta: { title: `HireFix LoRA ${i + 1}` },
      };
      prevModel = [loraId, 0];
    }
    wf[HFS.KSAMPLER].inputs.model = prevModel;
  }

  return wf;
}

export { EDIT, HFQ, HFS };
