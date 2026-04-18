import { create } from 'zustand';
import { saveSettings } from './settingsPersist';

const PERSIST_KEYS = [
  'studioCheckpoint', 'studioSteps', 'studioCfg', 'studioSeed', 'studioMode', 'vlmAutoAnimate', 'skipDeleteConfirm',
  'studioResolution', 'studioNegPrompt', 'studioLoras', 'randomResolution', 'sequentialBatch',
  'hiresUpscaleBy', 'hiresMode', 'hiresDenoise', 'hiresCheckpoint', 'hiresUpscaleModel', 'hiresPrompt',
  'animatePreset', 'animateStyle', 'animateHighRes', 'animateMode', 'animateDirection',
];

const DEFAULTS = {
  studioCheckpoint: '', studioSteps: 15, studioCfg: 5, studioSeed: 0, studioMode: 'fast', vlmAutoAnimate: false, skipDeleteConfirm: false,
  studioResolution: 'square',
  studioNegPrompt: 'extra digits, (particles, adversarial_noise:1.2), multiple views, multiple angle, split view, grid view, two shot, outside border, picture frame, framed, border, letterboxed, pillarboxed, 2koma, modern, recent, old, oldest, cartoon, graphic, text, painting, crayon, graphite, abstract, glitch, deformed, mutated, ugly, disfigured, long body, lowres, bad anatomy, bad hands, missing fingers, extra fingers, extra digits, fewer digits, cropped, very displeasing, (worst quality, bad quality:1.2), sketch, jpeg artifacts, signature, watermark, username, (censored, bar_censor, mosaic_censor:1.2), simple background, conjoined, bad ai-generated',
  studioLoras: [], randomResolution: false, sequentialBatch: false,
  hiresUpscaleBy: 1.15, hiresMode: 'fast', hiresDenoise: 0.4,
  hiresCheckpoint: '', hiresUpscaleModel: 'RealESRGAN_x4plus_anime_6B.pth',
  hiresPrompt: 'improve the quality of this image, enhance details and sharpness.',
  animatePreset: 'fast', animateStyle: 'animation', animateHighRes: false,
  animateMode: 'wan22',
  animateDirection: '',
};

function debouncedSave(state) {
  const data = {};
  for (const k of PERSIST_KEYS) data[k] = state[k];
  saveSettings(data);
}

const useStudioSettings = create((set, get) => ({
  ...DEFAULTS,
  setStudioCheckpoint: (v) => { set({ studioCheckpoint: v }); debouncedSave({ ...get(), studioCheckpoint: v }); },
  setStudioMode: (v) => { set({ studioMode: v }); debouncedSave({ ...get(), studioMode: v }); },
  setVlmAutoAnimate: (v) => { set({ vlmAutoAnimate: v }); debouncedSave({ ...get(), vlmAutoAnimate: v }); },
  setSkipDeleteConfirm: (v) => { set({ skipDeleteConfirm: v }); debouncedSave({ ...get(), skipDeleteConfirm: v }); },
  setStudioSteps: (v) => { set({ studioSteps: v }); debouncedSave({ ...get(), studioSteps: v }); },
  setStudioCfg: (v) => { set({ studioCfg: v }); debouncedSave({ ...get(), studioCfg: v }); },
  setStudioSeed: (v) => { set({ studioSeed: v }); debouncedSave({ ...get(), studioSeed: v }); },
  setStudioResolution: (v) => { set({ studioResolution: v }); debouncedSave({ ...get(), studioResolution: v }); },
  setStudioNegPrompt: (v) => { set({ studioNegPrompt: v }); debouncedSave({ ...get(), studioNegPrompt: v }); },
  setRandomResolution: (v) => { set({ randomResolution: v }); debouncedSave({ ...get(), randomResolution: v }); },
  setSequentialBatch: (v) => { set({ sequentialBatch: v }); debouncedSave({ ...get(), sequentialBatch: v }); },
  randomizeSeed: () => { const v = Math.floor(Math.random() * 2147483647); set({ studioSeed: v }); debouncedSave({ ...get(), studioSeed: v }); },
  setHiresUpscaleBy: (v) => { set({ hiresUpscaleBy: v }); debouncedSave({ ...get(), hiresUpscaleBy: v }); },
  setHiresMode: (v) => { set({ hiresMode: v }); debouncedSave({ ...get(), hiresMode: v }); },
  setHiresDenoise: (v) => { set({ hiresDenoise: v }); debouncedSave({ ...get(), hiresDenoise: v }); },
  setHiresCheckpoint: (v) => { set({ hiresCheckpoint: v }); debouncedSave({ ...get(), hiresCheckpoint: v }); },
  setHiresUpscaleModel: (v) => { set({ hiresUpscaleModel: v }); debouncedSave({ ...get(), hiresUpscaleModel: v }); },
  setHiresPrompt: (v) => { set({ hiresPrompt: v }); debouncedSave({ ...get(), hiresPrompt: v }); },
  setAnimatePreset: (v) => { set({ animatePreset: v }); debouncedSave({ ...get(), animatePreset: v }); },
  setAnimateStyle: (v) => { set({ animateStyle: v }); debouncedSave({ ...get(), animateStyle: v }); },
  setAnimateHighRes: (v) => { set({ animateHighRes: v }); debouncedSave({ ...get(), animateHighRes: v }); },
  setAnimateMode: (v) => { set({ animateMode: v }); debouncedSave({ ...get(), animateMode: v }); },
  setAnimateDirection: (v) => { set({ animateDirection: v }); debouncedSave({ ...get(), animateDirection: v }); },

  // LoRAs
  addLora: (l) => { const s = get(); const n = [...s.studioLoras, { id: Date.now(), strength: 1, enabled: true, ...l }]; set({ studioLoras: n }); debouncedSave({ ...s, studioLoras: n }); },
  removeLora: (id) => { const s = get(); const n = s.studioLoras.filter(l => l.id !== id); set({ studioLoras: n }); debouncedSave({ ...s, studioLoras: n }); },
  updateLora: (id, u) => { const s = get(); const n = s.studioLoras.map(l => l.id === id ? { ...l, ...u } : l); set({ studioLoras: n }); debouncedSave({ ...s, studioLoras: n }); },
  clearLoras: () => { set({ studioLoras: [] }); debouncedSave({ ...get(), studioLoras: [] }); },

  comfyCheckpoints: [], comfyLoras: [],
  setComfyCheckpoints: (v) => set({ comfyCheckpoints: v }),
  setComfyLoras: (v) => set({ comfyLoras: v }),

  loadStudioSettings: (data) => {
    const patch = {};
    for (const k of PERSIST_KEYS) { if (data[k] !== undefined) patch[k] = data[k]; }
    set(patch);
  },
}));

export { DEFAULTS as STUDIO_DEFAULTS };
export default useStudioSettings;
