import { create } from 'zustand';
import { saveSettings } from './settingsPersist';

const PERSIST_KEYS = [
  // Shared config — Wan 2.2
  'vlmModelPath', 'vlmMmprojPath', 'vlmCtx', 'vlmImageTokens', 'vlmAfterInference', 'vlmVideoMode', 'vlmTargetFrames', 'pythonPath', 'comfyLauncherPath', 'comfyCloseAction',
  'modelPresets', 'activePresetFast', 'activePresetQuality',
  'clipModel', 'vaeModel',
  // Shared config — LTX 2.3
  'ltxCheckpoint', 'ltxClip1', 'ltxClip2', 'ltxAudioVae', 'ltxUpscaleModel',
  // Long Video
  'isV2V', 'resolution', 'highRes', 'useDasiwa', 'qualityPreset',
  'engine', 'videoWorkflow',
  'userPrompt', 'cameraPromptLV', 'systemPromptI2V', 'systemPromptExtend', 'negPromptLV',
  'seed', 'videoDuration', 'fps', 'motionLatentCount', 'targetFrames',
  'vlmModeLV', 'vlmAutoGenerate', 'lorasHigh', 'lorasLow', 'loraPathHigh', 'loraPathLow',
  'advancedEnabled', 'advSteps', 'advCfg', 'advShift', 'advDuration', 'advFps', 'advWidth', 'advHeight',
  'vlmExtendSummary', 'vlmExtendFrameMode',
  'showToasts',
];

const DEFAULT_SYSTEM_PROMPT_I2V = `You are an expert Video Prompt Engineer for the Wan video model.

CRITICAL RULE: You must output ONLY the final video prompt paragraph. Do NOT say a greeting. Do NOT explain your choices. Output nothing but the prompt itself.

Here are my inputs for this specific video:
1. Attached Image.
2. Base Subject/Action: {{IMAGE_PROMPT}}
3. Camera Motion & Framing: {{CAMERA}}

Study the image: subject, pose, environment, lighting, camera angle, depth. Build a video prompt that animates this image into motion. The first frame must match the image exactly.

Build the video prompt as a single, highly detailed, flowing paragraph by seamlessly weaving together these exact elements in order:

**STEP 1: Establish the Shot and Cinematography**
Start with the camera details. Define the shot type, camera movement, and lens characteristics.

**STEP 2: Describe the Subject and Setting**
Provide a rich, highly detailed description of the main subjects and their environment. Specify textures, clothing, colors, and spatial relationships exactly as they look in the image.

**STEP 3: Detail the Action, Physics, and Body Language**
Describe the motion fluidly and chronologically. Focus entirely on visual actions: how the character moves, their facial expressions, and how they interact with their environment. Describe environmental physics like how fabric flows, how dust floats in the air, or how water ripples. Do NOT include any spoken dialogue or speaking motions.

**STEP 4: Enhance with Lighting and Atmosphere**
Finish by defining the visual mood. Describe the lighting setup, color grading, and weather/atmospheric effects.

REMINDER: Write this as one continuous, incredibly descriptive, cinematic paragraph. No bullet points. No intro or outro text. ONLY the final prompt.`;

const DEFAULT_SYSTEM_PROMPT_EXTEND = `You are an expert Video Prompt Engineer for the Wan video model, specializing in video extension.

CRITICAL RULE: You must output ONLY the final video prompt paragraph. Do NOT say a greeting. Do NOT explain your choices. Output nothing but the prompt itself.

Here are my inputs:
1. Attached Video Frame(s) — these are from the END of the current video.
2. Base Subject/Action: {{IMAGE_PROMPT}}
3. Camera Motion & Framing: {{CAMERA}}

Your job is to generate a prompt that CONTINUES the video seamlessly from the last frame. Focus on what happens NEXT — maintain the same subject, environment, lighting, camera style, and motion trajectory.

Build the continuation prompt as a single, highly detailed, flowing paragraph:

**STEP 1: Resume the Camera**
Continue the camera movement naturally. If it was panning left, keep panning. If static, stay static. Match the shot type and lens.

**STEP 2: Continue the Subject and Action**
Describe what the subject does NEXT. Maintain their appearance, clothing, pose trajectory, and environment exactly. Do not restart or reintroduce — continue the motion.

**STEP 3: Extend the Physics and Motion**
Describe how ongoing motion continues: fabric still flowing, particles still drifting, water still rippling. Add new natural developments that follow from the current state.

**STEP 4: Maintain the Atmosphere**
Keep the same lighting, color grading, and mood. Only shift if the scene naturally calls for it (e.g. walking from shadow to sunlight).

REMINDER: Write this as one continuous, incredibly descriptive paragraph that seamlessly continues the video. No bullet points. No intro or outro text. ONLY the final prompt.`;

// Keep legacy export for backward compat
const DEFAULT_SYSTEM_PROMPT_LV = DEFAULT_SYSTEM_PROMPT_I2V;

const DEFAULTS = {
  vlmModelPath: '', vlmMmprojPath: '', vlmCtx: 16384, vlmImageTokens: 1024, vlmAfterInference: 'park', vlmVideoMode: 'single', vlmTargetFrames: 4, pythonPath: 'python', comfyLauncherPath: '', comfyCloseAction: 'ask',
  modelPresets: [],
  activePresetFast: '',
  activePresetQuality: '',
  clipModel: '', vaeModel: '',
  // LTX 2.3
  ltxCheckpoint: '', ltxClip1: '', ltxClip2: '', ltxAudioVae: '', ltxUpscaleModel: '',
  // Long Video
  engine: 'wan22', videoWorkflow: 'extend',
  isV2V: false, resolution: 'portrait', highRes: false, useDasiwa: false, qualityPreset: 'fast',
  userPrompt: '', cameraPromptLV: '',
  systemPromptI2V: DEFAULT_SYSTEM_PROMPT_I2V,
  systemPromptExtend: DEFAULT_SYSTEM_PROMPT_EXTEND,
  negPromptLV: '',
  seed: 0, videoDuration: 5, fps: 16, motionLatentCount: 1, targetFrames: 24,
  vlmModeLV: 'guided', vlmAutoGenerate: false, lorasHigh: [], lorasLow: [], loraPathHigh: '', loraPathLow: '',
  advancedEnabled: false, advSteps: 6, advCfg: 1, advShift: 8, advDuration: 5, advFps: 16, advWidth: 720, advHeight: 720,
  vlmExtendSummary: true, vlmExtendFrameMode: 'all',
  showToasts: true,
};

function debouncedSave(state) {
  const data = {};
  for (const key of PERSIST_KEYS) data[key] = state[key];
  saveSettings(data);
}

const useStore = create((set, get) => ({
  connected: false, setConnected: (v) => set({ connected: v }),
  comfyLaunchStatus: '', setComfyLaunchStatus: (v) => set({ comfyLaunchStatus: v }),

  // ── Shared: ComfyUI model lists ──
  comfyCheckpoints: [], comfyLoras: [], comfyClips: [], comfyVaes: [],
  comfyUpscaleModels: [], comfyLatentUpscaleModels: [], comfyLtxAudioVaes: [], comfyUnets: [],
  setComfyCheckpoints: (v) => set({ comfyCheckpoints: v }),
  setComfyLoras: (v) => set({ comfyLoras: v }),
  setComfyClips: (v) => set({ comfyClips: v }),
  setComfyVaes: (v) => set({ comfyVaes: v }),
  setComfyUpscaleModels: (v) => set({ comfyUpscaleModels: v }),
  setComfyUnets: (v) => set({ comfyUnets: v }),
  setComfyLatentUpscaleModels: (v) => set({ comfyLatentUpscaleModels: v }),
  setComfyLtxAudioVaes: (v) => set({ comfyLtxAudioVaes: v }),

  // ── Shared: VLM paths ──
  vlmModelPath: DEFAULTS.vlmModelPath,
  vlmMmprojPath: DEFAULTS.vlmMmprojPath,
  setVlmModelPath: (v) => { set({ vlmModelPath: v }); debouncedSave({ ...get(), vlmModelPath: v }); },
  setVlmMmprojPath: (v) => { set({ vlmMmprojPath: v }); debouncedSave({ ...get(), vlmMmprojPath: v }); },
  vlmCtx: 16384,
  setVlmCtx: (v) => { set({ vlmCtx: v }); debouncedSave({ ...get(), vlmCtx: v }); },
  vlmImageTokens: 1024,
  setVlmImageTokens: (v) => { set({ vlmImageTokens: v }); debouncedSave({ ...get(), vlmImageTokens: v }); },
  vlmAfterInference: 'park',
  setVlmAfterInference: (v) => { set({ vlmAfterInference: v }); debouncedSave({ ...get(), vlmAfterInference: v }); },
  vlmVideoMode: 'single', // 'single' | 'multi'
  setVlmVideoMode: (v) => { set({ vlmVideoMode: v }); debouncedSave({ ...get(), vlmVideoMode: v }); },
  vlmTargetFrames: 4,
  setVlmTargetFrames: (v) => { set({ vlmTargetFrames: v }); debouncedSave({ ...get(), vlmTargetFrames: v }); },
  pythonPath: 'python',
  setPythonPath: (v) => { set({ pythonPath: v }); debouncedSave({ ...get(), pythonPath: v }); },
  comfyLauncherPath: '',
  setComfyLauncherPath: (v) => { set({ comfyLauncherPath: v }); debouncedSave({ ...get(), comfyLauncherPath: v }); },
  comfyCloseAction: 'ask', // 'ask' | 'close' | 'keep'
  setComfyCloseAction: (v) => { set({ comfyCloseAction: v }); debouncedSave({ ...get(), comfyCloseAction: v }); },

  // ── Model Presets ──
  // Each preset: { id, name, mode: 'fast'|'quality', ckptHigh, ckptLow }
  modelPresets: [],
  activePresetFast: '',
  activePresetQuality: '',
  addPreset: (preset) => {
    const p = { id: `p_${Date.now()}`, name: 'New Preset', mode: 'fast', ckptHigh: '', ckptLow: '', ...preset };
    set(s => ({ modelPresets: [...s.modelPresets, p] }));
    debouncedSave({ ...get(), modelPresets: [...get().modelPresets] });
    return p.id;
  },
  updatePreset: (id, updates) => {
    set(s => ({ modelPresets: s.modelPresets.map(p => p.id === id ? { ...p, ...updates } : p) }));
    debouncedSave({ ...get(), modelPresets: [...get().modelPresets] });
  },
  deletePreset: (id) => {
    set(s => {
      const filtered = s.modelPresets.filter(p => p.id !== id);
      const patch = { modelPresets: filtered };
      if (s.activePresetFast === id) patch.activePresetFast = filtered.find(p => p.mode === 'fast')?.id || '';
      if (s.activePresetQuality === id) patch.activePresetQuality = filtered.find(p => p.mode === 'quality')?.id || '';
      return patch;
    });
    debouncedSave(get());
  },
  setActivePresetFast: (id) => { set({ activePresetFast: id }); debouncedSave({ ...get(), activePresetFast: id }); },
  setActivePresetQuality: (id) => { set({ activePresetQuality: id }); debouncedSave({ ...get(), activePresetQuality: id }); },
  /** Get checkpoint models for a given speed mode */
  getPresetCheckpoints: (mode) => {
    const s = get();
    const id = mode === 'fast' ? s.activePresetFast : s.activePresetQuality;
    const preset = s.modelPresets.find(p => p.id === id);
    return preset ? { ckptHigh: preset.ckptHigh, ckptLow: preset.ckptLow, name: preset.name } : { ckptHigh: '', ckptLow: '', name: '' };
  },

  clipModel: '', vaeModel: '',
  setClipModel: (v) => { set({ clipModel: v }); debouncedSave({ ...get(), clipModel: v }); },
  setVaeModel: (v) => { set({ vaeModel: v }); debouncedSave({ ...get(), vaeModel: v }); },

  // ── Shared: LTX 2.3 models ──
  ltxCheckpoint: '', ltxClip1: '', ltxClip2: '', ltxAudioVae: '', ltxUpscaleModel: '',
  setLtxCheckpoint: (v) => { set({ ltxCheckpoint: v }); debouncedSave({ ...get(), ltxCheckpoint: v }); },
  setLtxClip1: (v) => { set({ ltxClip1: v }); debouncedSave({ ...get(), ltxClip1: v }); },
  setLtxClip2: (v) => { set({ ltxClip2: v }); debouncedSave({ ...get(), ltxClip2: v }); },
  setLtxAudioVae: (v) => { set({ ltxAudioVae: v }); debouncedSave({ ...get(), ltxAudioVae: v }); },
  setLtxUpscaleModel: (v) => { set({ ltxUpscaleModel: v }); debouncedSave({ ...get(), ltxUpscaleModel: v }); },

  // ── Long Video: Engine & Workflow ──
  engine: 'wan22', videoWorkflow: 'extend',
  setEngine: (v) => { set({ engine: v, videoWorkflow: 'extend', isV2V: true }); debouncedSave({ ...get(), engine: v, videoWorkflow: 'extend', isV2V: true }); },
  setVideoWorkflow: (v) => {
    const isExtend = v === 'extend';
    set({ videoWorkflow: v, isV2V: isExtend });
    // Clear package chain when switching to new I2V
    if (!isExtend) set({ lastPkgId: null, lastPkgSessionId: null });
    debouncedSave({ ...get(), videoWorkflow: v, isV2V: isExtend });
  },

  // ── Long Video: Mode ──
  isV2V: false, resolution: 'portrait', highRes: false, useDasiwa: false, qualityPreset: 'fast',
  setIsV2V: (v) => { set({ isV2V: v }); debouncedSave({ ...get(), isV2V: v }); },
  setResolution: (v) => { set({ resolution: v }); debouncedSave({ ...get(), resolution: v }); },
  setHighRes: (v) => { set({ highRes: v }); debouncedSave({ ...get(), highRes: v }); },
  setUseDasiwa: (v) => { set({ useDasiwa: v }); debouncedSave({ ...get(), useDasiwa: v }); },
  setQualityPreset: (v) => { set({ qualityPreset: v }); debouncedSave({ ...get(), qualityPreset: v }); },

  // ── Long Video: Input ──
  imageName: '', videoName: '', imagePreview: null, videoPreview: null,
  lastPkgId: null, lastPkgSessionId: null,
  setImageName: (v) => set({ imageName: v }), setVideoName: (v) => set({ videoName: v }),
  setImagePreview: (v) => set({ imagePreview: v }), setVideoPreview: (v) => set({ videoPreview: v }),

  // ── Long Video: Prompts + VLM ──
  userPrompt: '', cameraPromptLV: '',
  systemPromptI2V: DEFAULT_SYSTEM_PROMPT_I2V,
  systemPromptExtend: DEFAULT_SYSTEM_PROMPT_EXTEND,
  vlmResponse: '',
  vlmModeLV: 'guided', // 'off' | 'guided' | 'auto'
  vlmAutoGenerate: false,
  setVlmModeLV: (v) => { set({ vlmModeLV: v }); debouncedSave({ ...get(), vlmModeLV: v }); },
  setVlmAutoGenerate: (v) => { set({ vlmAutoGenerate: v }); debouncedSave({ ...get(), vlmAutoGenerate: v }); },
  setUserPrompt: (v) => { set({ userPrompt: v }); debouncedSave({ ...get(), userPrompt: v }); },
  setCameraPromptLV: (v) => { set({ cameraPromptLV: v }); debouncedSave({ ...get(), cameraPromptLV: v }); },
  setSystemPromptI2V: (v) => { set({ systemPromptI2V: v }); debouncedSave({ ...get(), systemPromptI2V: v }); },
  setSystemPromptExtend: (v) => { set({ systemPromptExtend: v }); debouncedSave({ ...get(), systemPromptExtend: v }); },
  setVlmResponse: (v) => set({ vlmResponse: v }),
  negPromptLV: '',
  setNegPromptLV: (v) => { set({ negPromptLV: v }); debouncedSave({ ...get(), negPromptLV: v }); },

  // ── Long Video: Generation params ──
  seed: 0, videoDuration: 5, fps: 16, motionLatentCount: 1, targetFrames: 24,
  setSeed: (v) => { set({ seed: v }); debouncedSave({ ...get(), seed: v }); },
  setVideoDuration: (v) => { set({ videoDuration: v }); debouncedSave({ ...get(), videoDuration: v }); },
  setFps: (v) => { set({ fps: v }); debouncedSave({ ...get(), fps: v }); },
  setMotionLatentCount: (v) => { set({ motionLatentCount: v }); debouncedSave({ ...get(), motionLatentCount: v }); },
  setTargetFrames: (v) => { set({ targetFrames: v }); debouncedSave({ ...get(), targetFrames: v }); },
  randomizeSeed: () => { const v = Math.floor(Math.random() * 2147483647); set({ seed: v }); debouncedSave({ ...get(), seed: v }); },

  // ── Advanced overrides ──
  advancedEnabled: false, advSteps: 6, advCfg: 1, advShift: 8, advDuration: 5, advFps: 16, advWidth: 720, advHeight: 720,
  setAdvancedEnabled: (v) => { set({ advancedEnabled: v }); debouncedSave({ ...get(), advancedEnabled: v }); },
  setAdvSteps: (v) => { set({ advSteps: v }); debouncedSave({ ...get(), advSteps: v }); },
  setAdvCfg: (v) => { set({ advCfg: v }); debouncedSave({ ...get(), advCfg: v }); },
  setAdvShift: (v) => { set({ advShift: v }); debouncedSave({ ...get(), advShift: v }); },
  setAdvDuration: (v) => { set({ advDuration: v }); debouncedSave({ ...get(), advDuration: v }); },
  setAdvFps: (v) => { set({ advFps: v }); debouncedSave({ ...get(), advFps: v }); },
  setAdvWidth: (v) => { set({ advWidth: v }); debouncedSave({ ...get(), advWidth: v }); },
  setAdvHeight: (v) => { set({ advHeight: v }); debouncedSave({ ...get(), advHeight: v }); },

  // ── VLM Extend settings ──
  vlmExtendSummary: true, vlmExtendFrameMode: 'all',
  setVlmExtendSummary: (v) => { set({ vlmExtendSummary: v }); debouncedSave({ ...get(), vlmExtendSummary: v }); },
  setVlmExtendFrameMode: (v) => { set({ vlmExtendFrameMode: v }); debouncedSave({ ...get(), vlmExtendFrameMode: v }); },

  // ── Long Video: LoRAs ──
  lorasHigh: [], lorasLow: [],
  loraPathHigh: '', loraPathLow: '',
  setLoraPathHigh: (v) => { set({ loraPathHigh: v }); debouncedSave({ ...get(), loraPathHigh: v }); },
  setLoraPathLow: (v) => { set({ loraPathLow: v }); debouncedSave({ ...get(), loraPathLow: v }); },
  availableLorasHigh: [], availableLorasLow: [],
  setAvailableLorasHigh: (v) => set({ availableLorasHigh: v }),
  setAvailableLorasLow: (v) => set({ availableLorasLow: v }),
  addLoraHigh: (l) => { const s = get(); const n = [...s.lorasHigh, { id: Date.now(), strength_model: 1, enabled: true, ...l }]; set({ lorasHigh: n }); debouncedSave({ ...s, lorasHigh: n }); },
  removeLoraHigh: (id) => { const s = get(); const n = s.lorasHigh.filter(l => l.id !== id); set({ lorasHigh: n }); debouncedSave({ ...s, lorasHigh: n }); },
  updateLoraHigh: (id, u) => { const s = get(); const n = s.lorasHigh.map(l => l.id === id ? { ...l, ...u } : l); set({ lorasHigh: n }); debouncedSave({ ...s, lorasHigh: n }); },
  clearLorasHigh: () => { set({ lorasHigh: [] }); debouncedSave({ ...get(), lorasHigh: [] }); },
  addLoraLow: (l) => { const s = get(); const n = [...s.lorasLow, { id: Date.now()+1, strength_model: 1, enabled: true, ...l }]; set({ lorasLow: n }); debouncedSave({ ...s, lorasLow: n }); },
  removeLoraLow: (id) => { const s = get(); const n = s.lorasLow.filter(l => l.id !== id); set({ lorasLow: n }); debouncedSave({ ...s, lorasLow: n }); },
  updateLoraLow: (id, u) => { const s = get(); const n = s.lorasLow.map(l => l.id === id ? { ...l, ...u } : l); set({ lorasLow: n }); debouncedSave({ ...s, lorasLow: n }); },
  clearLorasLow: () => { set({ lorasLow: [] }); debouncedSave({ ...get(), lorasLow: [] }); },

  // ── Long Video: Media lists ──
  availableImages: [], availableVideos: [],
  setAvailableImages: (v) => set({ availableImages: v }),
  setAvailableVideos: (v) => set({ availableVideos: v }),

  // ── Long Video: Generation state ──
  generating: false, progress: 0, progressMax: 0,
  outputVideo: null, localOutputPath: null,
  error: null, currentNode: '', promptId: null, generationCount: 0,
  setGenerating: (v) => set({ generating: v }),
  setProgress: (v, max) => set({ progress: v, progressMax: max }),
  setOutputVideo: (v) => set({ outputVideo: v }),
  setLocalOutputPath: (v) => set({ localOutputPath: v }),
  setError: (v) => set({ error: v }),
  setCurrentNode: (v) => set({ currentNode: v }),
  setPromptId: (v) => set({ promptId: v }),
  incrementGeneration: () => set((s) => ({ generationCount: s.generationCount + 1 })),

  // ── Global generation tracker (cross-tab) ──
  activeGen: null,
  toasts: [],
  showToasts: true,
  setShowToasts: (v) => { set({ showToasts: v }); debouncedSave({ ...get(), showToasts: v }); },
  startGeneration: (source, label) => set({ activeGen: { source, label, progress: 0, startedAt: Date.now() } }),
  updateGenProgress: (progress) => set(s => s.activeGen ? { activeGen: { ...s.activeGen, progress } } : {}),
  endGeneration: (source, message, type = 'success') => set(s => ({
    activeGen: s.activeGen?.source === source ? null : s.activeGen,
    toasts: s.showToasts ? [...s.toasts.slice(-4), { id: Date.now(), message, type, source, timestamp: Date.now() }] : s.toasts,
  })),
  dismissToast: (id) => set(s => ({ toasts: s.toasts.filter(t => t.id !== id) })),

  loadPersistedState: (data) => {
    const patch = {};
    for (const key of PERSIST_KEYS) { if (data[key] !== undefined) patch[key] = data[key]; }

    // ── Migrate old checkpoint fields to preset system ──
    if (!data.modelPresets?.length && (data.ckptFastRealisticHigh || data.ckptQualityRealisticHigh)) {
      const presets = [];
      if (data.ckptFastRealisticHigh || data.ckptFastRealisticLow) {
        presets.push({ id: 'migrated_fast_realistic', name: 'Realistic', mode: 'fast', ckptHigh: data.ckptFastRealisticHigh || '', ckptLow: data.ckptFastRealisticLow || '' });
      }
      if (data.ckptFastAnimationHigh || data.ckptFastAnimationLow) {
        presets.push({ id: 'migrated_fast_animation', name: 'Animation', mode: 'fast', ckptHigh: data.ckptFastAnimationHigh || '', ckptLow: data.ckptFastAnimationLow || '' });
      }
      if (data.ckptQualityRealisticHigh || data.ckptQualityRealisticLow) {
        presets.push({ id: 'migrated_quality_realistic', name: 'Realistic', mode: 'quality', ckptHigh: data.ckptQualityRealisticHigh || '', ckptLow: data.ckptQualityRealisticLow || '' });
      }
      if (data.ckptQualityAnimationHigh || data.ckptQualityAnimationLow) {
        presets.push({ id: 'migrated_quality_animation', name: 'Animation', mode: 'quality', ckptHigh: data.ckptQualityAnimationHigh || '', ckptLow: data.ckptQualityAnimationLow || '' });
      }
      if (presets.length > 0) {
        patch.modelPresets = presets;
        patch.activePresetFast = presets.find(p => p.mode === 'fast')?.id || '';
        patch.activePresetQuality = presets.find(p => p.mode === 'quality')?.id || '';
        console.log(`[Store] Migrated ${presets.length} checkpoint presets from old format`);
      }
    }

    set(patch);
  },
  resetAll: () => { set({ ...DEFAULTS }); debouncedSave(DEFAULTS); },
}));

export { DEFAULTS, DEFAULT_SYSTEM_PROMPT_LV, DEFAULT_SYSTEM_PROMPT_I2V, DEFAULT_SYSTEM_PROMPT_EXTEND };
export default useStore;
