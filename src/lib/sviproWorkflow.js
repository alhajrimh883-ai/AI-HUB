/**
 * SVIPRO Workflow Builders
 * I2V:    PainterI2VAdvanced → SaveLatent (output/) + SaveVideoChunk (project folder)
 * Extend: WanImageToVideoSVIPro → SaveLatent (output/) + SaveVideoChunk (project folder)
 *
 * Latent flow:
 *   SaveLatent → ComfyUI output/  → app grabs to project folder
 *   App pushes from project folder → ComfyUI input/
 *   LoadLatent reads from input/
 *
 * Video flow:
 *   SaveVideoChunk → project folder directly (no grab needed)
 *   App pushes from project folder → ComfyUI input/
 *   VHS_LoadVideo reads from input/
 */

import i2vBase from '../../workflow/I2V.json';
import extendBase from '../../workflow/Extend.json';
import plvResetBase from '../../workflow/PLV-Reset.json';

function deepCopy(obj) { return JSON.parse(JSON.stringify(obj)); }

function nextNodeId(wf) {
  let max = 0;
  for (const id of Object.keys(wf)) {
    const n = parseInt(id.replace(/[^0-9]/g, ''), 10);
    if (!isNaN(n) && n > max) max = n;
  }
  return max + 1;
}

function injectLoras(wf, baseId, consumerId, loras) {
  if (!loras || loras.length === 0) return;
  let prevId = baseId;
  for (const lora of loras) {
    const newId = String(nextNodeId(wf));
    wf[newId] = {
      inputs: { lora_name: lora.name, strength_model: lora.strength ?? lora.strength_model ?? 1, model: [prevId, 0] },
      class_type: 'LoraLoaderModelOnly',
      _meta: { title: `User LoRA: ${lora.name}` },
    };
    prevId = newId;
  }
  if (wf[consumerId]?.inputs?.model) wf[consumerId].inputs.model = [prevId, 0];
}

export const PRESETS = {
  fast:    { steps: 4,  cfg: 1,   i2vShift: 5, extShift: 12, label: '⚡ Fast (4 steps)' },
  quality: { steps: 20, cfg: 3.5, i2vShift: 5, extShift: 12, label: '🎨 Quality (20 steps)' },
};

const RES_MAP = { portrait: 1, square: 2, landscape: 3 };

// ═══════════════════════════════════════════════════════════════════
// I2V — Image to Video (PainterI2VAdvanced)
// SaveLatent(92) → output/   SaveVideoChunk(88) → project folder
// ═══════════════════════════════════════════════════════════════════

const I2V = {
  LOAD_IMAGE:       '7',
  SAVE_LATENT:      '92',      // SaveLatent → output/ (app grabs this)
  SAVE_VIDEO:       '93',      // SaveVideo → output/ (standard, reports via WebSocket)
  VAE_LOADER:       '56:47',
  CLIP_POS:         '56:49',
  CLIP_NEG:         '56:50',
  CLIP_LOADER:      '56:51',
  MODEL_SD3_LOW:    '56:53',
  CKPT_HIGH:        '56:54',
  CKPT_LOW:         '56:55',
  MODEL_SD3_HIGH:   '56:46',
  SAMPLER_HIGH:     '56:44:5',
  SAMPLER_LOW:      '56:44:6',
  VAE_DECODE:       '56:44:16',
  FPS:              '56:44:37',
  SECONDS:          '56:44:38',
  TOTAL_STEPS:      '56:44:40',
  CFG:              '56:44:42',
  RES_TIER:         '56:32:21',
  RES_SWITCH_HI:    '56:32:22',
  RES_SWITCH_LO:    '56:32:23',
};

export function buildI2V(params) {
  const wf = deepCopy(i2vBase);
  const fallback = PRESETS[params.qualityPreset] || PRESETS.fast;

  // SaveLatent + SaveVideo prefixes (session-scoped so app can find them in output/)
  if (params.latentPrefix) wf[I2V.SAVE_LATENT].inputs.filename_prefix = params.latentPrefix;
  if (params.videoPrefix) wf[I2V.SAVE_VIDEO].inputs.filename_prefix = params.videoPrefix;

  // Image
  if (params.imageName) wf[I2V.LOAD_IMAGE].inputs.image = params.imageName;

  // Steps, CFG, Shift (preset settings override fallback defaults)
  wf[I2V.TOTAL_STEPS].inputs['Total Steps'] = params.settings?.steps ?? fallback.steps;
  wf[I2V.CFG].inputs.CFG = params.settings?.cfg ?? fallback.cfg;
  wf[I2V.MODEL_SD3_HIGH].inputs.shift = params.settings?.shift ?? fallback.i2vShift;
  wf[I2V.MODEL_SD3_LOW].inputs.shift = params.settings?.shift ?? fallback.i2vShift;

  // FPS + Duration
  wf[I2V.FPS].inputs.value = params.fps ?? 16;
  wf[I2V.SECONDS].inputs.value = params.videoDuration ?? 5;
  wf[I2V.SAVE_VIDEO].inputs.fps = params.fps ?? 16;

  // Checkpoints
  if (params.ckptHigh) wf[I2V.CKPT_HIGH].inputs.ckpt_name = params.ckptHigh;
  if (params.ckptLow) wf[I2V.CKPT_LOW].inputs.ckpt_name = params.ckptLow;

  // CLIP + VAE
  if (params.clipModel) wf[I2V.CLIP_LOADER].inputs.clip_name = params.clipModel;
  if (params.vaeModel) wf[I2V.VAE_LOADER].inputs.vae_name = params.vaeModel;

  // Prompts
  wf[I2V.CLIP_POS].inputs.text = params.userPrompt || '';
  if (params.negPrompt) wf[I2V.CLIP_NEG].inputs.text = params.negPrompt;

  // Seed
  wf[I2V.SAMPLER_HIGH].inputs.noise_seed = 0;
  wf[I2V.SAMPLER_LOW].inputs.noise_seed = 0;

  // Resolution
  if (params.resolution && RES_MAP[params.resolution]) {
    wf[I2V.RES_SWITCH_LO].inputs.selection_setting = RES_MAP[params.resolution];
    wf[I2V.RES_SWITCH_HI].inputs.selection_setting = RES_MAP[params.resolution];
  }
  if (params.highRes !== undefined) wf[I2V.RES_TIER].inputs.switch = !!params.highRes;

  // LoRA injection (between ModelSamplingSD3 and KSampler)
  injectLoras(wf, I2V.MODEL_SD3_HIGH, I2V.SAMPLER_HIGH, (params.lorasHigh || []).filter(l => l.enabled !== false));
  injectLoras(wf, I2V.MODEL_SD3_LOW, I2V.SAMPLER_LOW, (params.lorasLow || []).filter(l => l.enabled !== false));

  return wf;
}

// ═══════════════════════════════════════════════════════════════════
// Extend — Video Extending (WanImageToVideoSVIPro)
// SaveLatent(147) → output/   SaveVideoChunk(100) → project folder
// LoadLatent(140) ← input/    VHS_LoadVideo(141) ← input/
// ═══════════════════════════════════════════════════════════════════

const EXT = {
  VAE_ENCODE:       '93',      // anchor — takes first frame from node 124
  SAVE_PATH:        '105',
  FILE_NAME:        '106',
  VAE_LOADER:       '113',
  CLIP_POS:         '115',
  CLIP_NEG:         '116',
  CLIP_LOADER:      '117',
  MODEL_SD3_LOW:    '119',     // model from LoRA LOW (144)
  CKPT_HIGH:        '120',
  CKPT_LOW:         '121',
  MODEL_SD3_HIGH:   '122',     // model from LoRA HIGH (145)
  PICK_FIRST_FRAME: '124',     // picks first frame from video → anchor
  LOAD_LATENT:      '140',     // reads from ComfyUI input/
  LOAD_VIDEO:       '141',     // reads from ComfyUI input/
  LORA_LOW:         '144',     // SVI PRO LOW, model from NAG LOW (118)
  LORA_HIGH:        '145',     // SVI PRO HIGH, model from NAG HIGH (114)
  SAVE_LATENT:      '147',     // SaveLatent → output/ (app grabs this)
  CREATE_VIDEO:     '148',     // CreateVideo → video object
  SAVE_VIDEO:       '149',     // SaveVideo → output/video/
  TRIM_OUTPUT:      '150',     // Pick From Batch end count=76 (trims overlap frames)
  SVI_PRO:          '151',     // WanImageToVideoSVIProFLF (replaces 87:88)
  END_VAE_ENCODE:   '152',     // VAEEncode for end frame target
  END_IMAGE:        '153',     // LoadImage for end frame target
  USE_END_SAMPLES:  '154',     // easy boolean — enable last frame control
  SAMPLER_HIGH:     '87:5',    // model from ModelSD3 HIGH (122)
  SAMPLER_LOW:      '87:6',    // model from ModelSD3 LOW (119)
  FPS:              '87:37',
  SECONDS:          '87:38',
  TOTAL_STEPS:      '87:40',
  CFG:              '87:42',
};

export function buildExtend(params) {
  const wf = deepCopy(extendBase);
  const fallback = PRESETS[params.qualityPreset] || PRESETS.fast;

  // Project folder metadata (for Director tracking)
  if (params.projectPath) wf[EXT.SAVE_PATH].inputs.text = params.projectPath;
  if (params.fileName) wf[EXT.FILE_NAME].inputs.text = params.fileName;

  // SaveLatent prefix (session-scoped so app can find it in output/)
  if (params.latentPrefix) wf[EXT.SAVE_LATENT].inputs.filename_prefix = params.latentPrefix;

  // SaveVideo prefix (session-scoped so app can find it in output/)
  if (params.videoPrefix) wf[EXT.SAVE_VIDEO].inputs.filename_prefix = params.videoPrefix;

  // Load files (must be in ComfyUI input/)
  wf[EXT.LOAD_LATENT].inputs.latent = params.latentName;
  wf[EXT.LOAD_VIDEO].inputs.video = params.videoName;

  // Pick direction no longer needed — first frame picked by node 124 for anchor

  // End frame control (WanImageToVideoSVIProFLF)
  // When enabled, SVI PRO guides generation toward the end_samples target
  if (params.useEndSamples) {
    wf[EXT.USE_END_SAMPLES].inputs.value = true;
    if (params.endImageName) wf[EXT.END_IMAGE].inputs.image = params.endImageName;
  }

  // Steps, CFG, Shift (preset settings override fallback defaults)
  wf[EXT.TOTAL_STEPS].inputs['Total Steps'] = params.settings?.steps ?? fallback.steps;
  wf[EXT.CFG].inputs.CFG = params.settings?.cfg ?? fallback.cfg;
  wf[EXT.MODEL_SD3_HIGH].inputs.shift = params.settings?.shift ?? fallback.extShift;
  wf[EXT.MODEL_SD3_LOW].inputs.shift = params.settings?.shift ?? fallback.extShift;

  // FPS + Duration
  const fps = params.fps ?? 16;
  wf[EXT.FPS].inputs.value = fps;
  wf[EXT.SECONDS].inputs.value = params.videoDuration ?? 5;
  wf[EXT.CREATE_VIDEO].inputs.fps = fps;

  // Motion latent count
  // motion_latent_count (1) and trim count (76) are baked into Extend.json

  // Checkpoints
  if (params.ckptHigh) wf[EXT.CKPT_HIGH].inputs.ckpt_name = params.ckptHigh;
  if (params.ckptLow) wf[EXT.CKPT_LOW].inputs.ckpt_name = params.ckptLow;

  // CLIP + VAE
  if (params.clipModel) wf[EXT.CLIP_LOADER].inputs.clip_name = params.clipModel;
  if (params.vaeModel) wf[EXT.VAE_LOADER].inputs.vae_name = params.vaeModel;

  // Prompts
  wf[EXT.CLIP_POS].inputs.text = params.userPrompt || '';
  if (params.negPrompt) wf[EXT.CLIP_NEG].inputs.text = params.negPrompt;

  // Seed
  wf[EXT.SAMPLER_HIGH].inputs.noise_seed = 0;
  wf[EXT.SAMPLER_LOW].inputs.noise_seed = 0;

  // Apply required family LoRAs (SVI PRO)
  if (params.sviLoraHigh) wf[EXT.LORA_HIGH].inputs.lora_name = params.sviLoraHigh;
  if (params.sviLoraLow) wf[EXT.LORA_LOW].inputs.lora_name = params.sviLoraLow;

  // User LoRA injection (between SVI PRO LoRA and ModelSamplingSD3)
  // Chain: Ckpt → NAG → SVI LoRA → [user LoRAs] → ModelSD3 → KSampler
  injectLoras(wf, EXT.LORA_HIGH, EXT.MODEL_SD3_HIGH, (params.lorasHigh || []).filter(l => l.enabled !== false));
  injectLoras(wf, EXT.LORA_LOW, EXT.MODEL_SD3_LOW, (params.lorasLow || []).filter(l => l.enabled !== false));

  return wf;
}

// ── PLV Reset Node IDs ──
const PLV = {
  PAINTER:          '1',      // PainterLongVideo
  LOAD_VIDEO:       '2',      // current video
  PICK_LAST_FRAME:  '4',      // start_image = last frame
  VAE_LOADER:       '7',
  CLIP_NEG:         '8',
  CLIP_POS:         '9',
  CLIP_LOADER:      '10',
  MODEL_SD3_LOW:    '95',
  MODEL_SD3_HIGH:   '96',
  NAG_HIGH:         '97',
  NAG_LOW:          '98',
  CKPT_HIGH:        '99',
  CKPT_LOW:         '100',
  CREATE_VIDEO:     '101',
  KSAMPLER_LOW:     '103',
  KSAMPLER_HIGH:    '104',
  DURATION:         '109',
  FPS:              '110',
  TOTAL_STEPS:      '111',
  CFG:              '112',
  SAVE_VIDEO:       '114',
  ORIGINAL_IMAGE:   '200',    // reset target (original first frame)
  TRIM_OUTPUT:      '201',    // Pick From Batch end count=80 (trims 1 overlap frame)
};

/**
 * Build PLV Reset workflow
 * PainterLongVideo with constant end frame → returns video to original image.
 * Model chain: Ckpt → NAG → [user LoRAs] → ModelSD3 → KSampler (NO SVI LoRAs)
 */
export function buildPLVReset(params) {
  const wf = deepCopy(plvResetBase);
  const fallback = PRESETS[params.qualityPreset] || PRESETS.fast;

  // Original image (end_image + initial_reference_image)
  wf[PLV.ORIGINAL_IMAGE].inputs.image = params.originalImageName;

  // Current video
  wf[PLV.LOAD_VIDEO].inputs.video = params.videoName;

  // Prompts
  wf[PLV.CLIP_POS].inputs.text = params.userPrompt || '';
  if (params.negPrompt) wf[PLV.CLIP_NEG].inputs.text = params.negPrompt;

  // Steps, CFG, Shift
  wf[PLV.TOTAL_STEPS].inputs['Total Steps'] = params.settings?.steps ?? fallback.steps;
  wf[PLV.CFG].inputs.CFG = params.settings?.cfg ?? fallback.cfg;
  wf[PLV.MODEL_SD3_HIGH].inputs.shift = params.settings?.shift ?? fallback.extShift;
  wf[PLV.MODEL_SD3_LOW].inputs.shift = params.settings?.shift ?? fallback.extShift;

  // FPS + Duration
  const fps = params.fps ?? 16;
  wf[PLV.FPS].inputs.value = fps;
  wf[PLV.DURATION].inputs.value = params.videoDuration ?? 5;
  wf[PLV.CREATE_VIDEO].inputs.fps = fps;

  // Motion amplitude
  if (params.motionAmplitude !== undefined) wf[PLV.PAINTER].inputs.motion_amplitude = params.motionAmplitude;

  // Overlap trimming handled by TRIM_OUTPUT node (201) — count=80 in workflow
  if (params.videoPrefix) wf[PLV.SAVE_VIDEO].inputs.filename_prefix = params.videoPrefix;

  // Models
  if (params.ckptHigh) wf[PLV.CKPT_HIGH].inputs.ckpt_name = params.ckptHigh;
  if (params.ckptLow) wf[PLV.CKPT_LOW].inputs.ckpt_name = params.ckptLow;
  if (params.clipModel) wf[PLV.CLIP_LOADER].inputs.clip_name = params.clipModel;
  if (params.vaeModel) wf[PLV.VAE_LOADER].inputs.vae_name = params.vaeModel;

  // Seed
  const seed = params.seed ?? Math.floor(Math.random() * 2 ** 53);
  wf[PLV.KSAMPLER_HIGH].inputs.noise_seed = seed;
  wf[PLV.KSAMPLER_LOW].inputs.noise_seed = seed;

  // User LoRA injection (between NAG and ModelSD3 — no SVI LoRAs in PLV)
  injectLoras(wf, PLV.NAG_HIGH, PLV.MODEL_SD3_HIGH, (params.lorasHigh || []).filter(l => l.enabled !== false));
  injectLoras(wf, PLV.NAG_LOW, PLV.MODEL_SD3_LOW, (params.lorasLow || []).filter(l => l.enabled !== false));

  return wf;
}

// ── Video to Latent ──
import videoToLatentBase from '../../workflow/VideoToLatent.json';

const V2L = {
  VAE_LOADER:  '1',
  VAE_ENCODE:  '2',
  LOAD_VIDEO:  '3',
  SAVE_LATENT: '4',
};

/**
 * Build VideoToLatent workflow
 * Loads a video → VAEEncode → SaveLatent. Used to import external videos into Director.
 * IMPORTANT: Only Wan 2.2 VAE works. Other VAEs will produce incompatible latents.
 */
export function buildVideoToLatent(params) {
  const wf = deepCopy(videoToLatentBase);
  if (params.vaeModel) wf[V2L.VAE_LOADER].inputs.vae_name = params.vaeModel;
  wf[V2L.LOAD_VIDEO].inputs.video = params.videoName;
  if (params.latentPrefix) wf[V2L.SAVE_LATENT].inputs.filename_prefix = params.latentPrefix;
  return wf;
}

export { I2V, EXT, PLV, V2L };
