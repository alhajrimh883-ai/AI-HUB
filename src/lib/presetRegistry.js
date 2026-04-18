/**
 * Preset Family Registry
 * Defines every workflow family the app supports.
 * Users create presets within these families — they can't import arbitrary workflows.
 */

export const TYPES = {
  t2i:     { label: 'Text to Image', icon: '🖼️' },
  video:   { label: 'Video', icon: '🎬' },
  edit:    { label: 'Edit', icon: '✏️' },
  hirefix: { label: 'HireFix', icon: '🔍' },
  vlm:     { label: 'VLM', icon: '🧠' },
};

export const MODES = {
  fast:    { label: '⚡ Fast', color: 'amber' },
  quality: { label: '🎨 Quality', color: 'violet' },
  both:    { label: '⚙️ Both', color: 'blue' },
};

// Shared Wan 2.2 field definitions
const WAN22_FIELDS = ['ckptHigh', 'ckptLow', 'clip', 'vae'];
const WAN22_LABELS = {
  ckptHigh: 'Checkpoint HIGH', ckptLow: 'Checkpoint LOW',
  clip: 'CLIP (Text Encoder)', vae: 'VAE',
};
const WAN22_SCAN = {
  ckptHigh: 'checkpoints', ckptLow: 'checkpoints',
  clip: 'text_encoders', vae: 'vae',
};
const WAN22_SVIPRO_REQUIRED = [
  { key: 'sviLoraHigh', label: 'SVI PRO LoRA HIGH', scanFolder: 'loras' },
  { key: 'sviLoraLow',  label: 'SVI PRO LoRA LOW',  scanFolder: 'loras' },
];

export const FAMILIES = {
  // ── Text to Image ──
  sdxl: {
    type: 't2i', label: 'SDXL', workflow: 'T2I.json',
    fields: ['checkpoint'],
    required: [],
    fieldLabels: { checkpoint: 'Checkpoint' },
    fieldScanFolder: { checkpoint: 'checkpoints' },
    defaults: { fast: { steps: 6, cfg: 2, shift: null }, quality: { steps: 25, cfg: 7, shift: null } },
  },
  qwen_t2i: {
    type: 't2i', label: 'Qwen', workflow: 'QwenT2I.json',
    fields: ['unet', 'clip', 'vae'],
    required: [],
    fieldLabels: { unet: 'Diffusion Model', clip: 'CLIP (Text Encoder)', vae: 'VAE' },
    fieldScanFolder: { unet: 'diffusion_models', clip: 'text_encoders', vae: 'vae' },
    defaults: { fast: { steps: 8, cfg: 4, shift: 3.1 }, quality: { steps: 20, cfg: 4, shift: 3.1 } },
  },

  // ── Video (unified — shown when separate toggle OFF) ──
  wan22: {
    type: 'video', label: 'Wan 2.2', unifiedOnly: true,
    description: 'Same models for I2V + Extend',
    workflow: ['I2V.json', 'Extend.json'],
    fields: WAN22_FIELDS, required: WAN22_SVIPRO_REQUIRED, dualLora: true,
    fieldLabels: WAN22_LABELS, fieldScanFolder: WAN22_SCAN,
    defaults: { fast: { steps: 4, cfg: 1, shift: 8 }, quality: { steps: 20, cfg: 3.5, shift: 12 } },
  },

  // ── Video (separate — shown when separate toggle ON) ──
  wan22_i2v: {
    type: 'video', label: 'Wan 2.2 I2V', separateOnly: true,
    description: 'PainterI2VAdvanced — image to video',
    workflow: 'I2V.json',
    fields: WAN22_FIELDS, required: [], dualLora: true,
    fieldLabels: WAN22_LABELS, fieldScanFolder: WAN22_SCAN,
    defaults: { fast: { steps: 4, cfg: 1, shift: 5 }, quality: { steps: 20, cfg: 3.5, shift: 5 } },
  },
  wan22_svipro: {
    type: 'video', label: 'Wan 2.2 SVIPRO', separateOnly: true,
    description: 'WanImageToVideoSVIPro — video extending',
    workflow: 'Extend.json',
    fields: WAN22_FIELDS, required: WAN22_SVIPRO_REQUIRED, dualLora: true,
    fieldLabels: WAN22_LABELS, fieldScanFolder: WAN22_SCAN,
    defaults: { fast: { steps: 4, cfg: 1, shift: 8 }, quality: { steps: 20, cfg: 3.5, shift: 12 } },
  },

  // ── Edit ──
  edit: {
    type: 'edit', label: 'Edit',
    workflows: {
      'qwen_edit': {
        label: 'Qwen (Edit)', json: 'Edit.json',
        fields: ['checkpoint', 'clip', 'vae'],
        settings: ['steps', 'cfg', 'shift'],
      },
    },
    required: [],
    fieldLabels: { checkpoint: 'Checkpoint', clip: 'CLIP', vae: 'VAE' },
    fieldScanFolder: { checkpoint: 'checkpoints', clip: 'text_encoders', vae: 'vae' },
    defaults: { fast: { steps: 8, cfg: 4, shift: 3 }, quality: { steps: 20, cfg: 4, shift: 3 } },
  },

  // ── HireFix ──
  hirefix: {
    type: 'hirefix', label: 'HireFix',
    workflows: {
      'qwen_hirefix': {
        label: 'Qwen (HireFix)', json: 'HireFix-Qwen.json',
        fields: ['checkpoint', 'clip', 'vae'],
        settings: ['steps', 'cfg', 'shift'],
      },
      'sdxl_hirefix': {
        label: 'SDXL (HireFix)', json: 'HireFix-SDXL.json',
        fields: [],
        settings: ['steps'],
        hasBackupPreset: true,
        description: 'Model + CFG + prompts from image metadata. Falls back to a T2I preset if metadata missing.',
      },
    },
    required: [],
    sharedSettings: ['denoise', 'upscaleBy', 'upscaleModel'],
    fieldLabels: { checkpoint: 'Checkpoint', clip: 'CLIP', vae: 'VAE' },
    fieldScanFolder: { checkpoint: 'checkpoints', clip: 'text_encoders', vae: 'vae' },
    defaults: { fast: { steps: 8, cfg: 4, shift: 3, denoise: 0.5, upscaleBy: 1.5 }, quality: { steps: 20, cfg: 4, shift: 3, denoise: 0.5, upscaleBy: 1.5 } },
  },

  // ── VLM ──
  vlm: {
    type: 'vlm', label: 'VLM',
    fields: ['vlmModel', 'mmproj'],
    required: [],
    fieldLabels: { vlmModel: 'VLM Model (GGUF)', mmproj: 'MMProj (GGUF)' },
    fieldScanFolder: { vlmModel: 'file_browser', mmproj: 'file_browser' },
    hasVlmSettings: true,
    defaults: { fast: { ctx: 4096, imageTokens: 256 }, quality: { ctx: 16384, imageTokens: 1024 } },
  },
};

/**
 * Get families for a type, filtered by separate toggle.
 * @param {string} type - 't2i' or 'video'
 * @param {boolean} separate - whether video presets are separated
 */
export function getFamiliesByType(type, separate = false) {
  return Object.entries(FAMILIES).filter(([, f]) => {
    if (f.type !== type) return false;
    if (type === 'video') {
      if (separate && f.unifiedOnly) return false;
      if (!separate && f.separateOnly) return false;
    }
    return true;
  });
}

export function getFamily(key) { return FAMILIES[key] || null; }

export function validateRequired(familyKey, requiredModels) {
  const family = FAMILIES[familyKey];
  if (!family || !family.required.length) return { valid: true, missing: [] };
  const missing = family.required.filter(r => !requiredModels[r.key]);
  return { valid: missing.length === 0, missing };
}

/** Check if a preset matches a mode filter (supports 'both') */
export function matchesMode(presetMode, filterMode) {
  if (presetMode === 'both' || presetMode === 'combined') return true;
  return presetMode === filterMode;
}
