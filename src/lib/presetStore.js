/**
 * Preset Store
 * Manages user-created presets, required family models, and settings.
 * Persisted to appdata via settings system.
 */

import { create } from 'zustand';
import { matchesMode } from './presetRegistry';

const usePresetStore = create((set, get) => ({
  // ── Generation Presets ──
  // Array of: { id, name, type, family, mode, models: {}, loras: [], linkedLoraIds: [], settings: { steps, cfg, shift } }
  presets: [],

  // ── LoRA Presets (app-wide pool) ──
  // Array of: { id, name, description, tags: [], isDual, single: { file, strength }, high: { file, strength }, low: { file, strength } }
  loraPresets: [],

  // ── Required family models ──
  requiredModels: {},

  // ── Video preset toggle ──
  separateVideoPresets: false, // false = one dropdown, true = separate I2V + Extend dropdowns

  // ── Currently selected presets (by mode) ──
  // { fast: { t2i: 'preset_id', video: 'preset_id', videoI2V: 'preset_id', videoExtend: 'preset_id' }, quality: { ... } }
  selectedPresets: { fast: {}, quality: {} },

  // ── Actions ──

  addPreset: (preset) => set(s => ({
    presets: [...s.presets, { ...preset, id: `preset_${Date.now()}` }],
  })),

  updatePreset: (id, updates) => set(s => ({
    presets: s.presets.map(p => p.id === id ? { ...p, ...updates } : p),
  })),

  deletePreset: (id) => set(s => ({
    presets: s.presets.filter(p => p.id !== id),
  })),

  // ── LoRA Preset Actions ──

  addLoraPreset: (lora) => set(s => ({
    loraPresets: [...s.loraPresets, { ...lora, id: `lora_${Date.now()}` }],
  })),

  updateLoraPreset: (id, updates) => set(s => ({
    loraPresets: s.loraPresets.map(l => l.id === id ? { ...l, ...updates } : l),
  })),

  deleteLoraPreset: (id) => set(s => ({
    loraPresets: s.loraPresets.filter(l => l.id !== id),
    // Also unlink from any generation presets
    presets: s.presets.map(p => p.linkedLoraIds?.includes(id)
      ? { ...p, linkedLoraIds: p.linkedLoraIds.filter(lid => lid !== id) }
      : p),
  })),

  linkLora: (presetId, loraId) => set(s => ({
    presets: s.presets.map(p => p.id === presetId
      ? { ...p, linkedLoraIds: [...new Set([...(p.linkedLoraIds || []), loraId])] }
      : p),
  })),

  unlinkLora: (presetId, loraId) => set(s => ({
    presets: s.presets.map(p => p.id === presetId
      ? { ...p, linkedLoraIds: (p.linkedLoraIds || []).filter(lid => lid !== loraId) }
      : p),
  })),

  /** Resolve linked LoRA presets for a generation preset */
  getLinkedLoras: (presetId) => {
    const preset = get().presets.find(p => p.id === presetId);
    if (!preset?.linkedLoraIds?.length) return [];
    return preset.linkedLoraIds
      .map(lid => get().loraPresets.find(l => l.id === lid))
      .filter(Boolean);
  },

  setRequiredModel: (familyKey, modelKey, value) => set(s => ({
    requiredModels: {
      ...s.requiredModels,
      [familyKey]: { ...(s.requiredModels[familyKey] || {}), [modelKey]: value },
    },
  })),

  setSeparateVideoPresets: (v) => set({ separateVideoPresets: v }),

  setSelectedPreset: (mode, slot, presetId) => set(s => ({
    selectedPresets: {
      ...s.selectedPresets,
      [mode]: { ...s.selectedPresets[mode], [slot]: presetId },
    },
  })),

  // ── Getters ──

  /** Get all presets filtered by type and mode ('both' presets always included) */
  getPresets: (type, mode) => {
    return get().presets.filter(p => p.type === type && matchesMode(p.mode, mode));
  },

  /** Get a specific preset by ID */
  getPreset: (id) => {
    return get().presets.find(p => p.id === id) || null;
  },

  /** Get the currently selected preset for a slot + mode, resolved for combined */
  getSelectedPreset: (mode, slot) => {
    const id = get().selectedPresets[mode]?.[slot];
    if (!id) return null;
    const preset = get().presets.find(p => p.id === id) || null;
    if (!preset) return null;
    return get().resolvePreset(preset, mode);
  },

  /** Get required models for a family */
  getRequiredModels: (familyKey) => {
    return get().requiredModels[familyKey] || {};
  },

  /** Get resolved VLM config from the selected VLM preset */
  getVlmConfig: () => {
    const id = get().selectedPresets?.both?.vlm;
    if (!id) return { enabled: false, modelPath: '', mmprojPath: '', ctx: 8192, imageTokens: 1024 };
    const preset = get().presets.find(p => p.id === id);
    if (!preset) return { enabled: false, modelPath: '', mmprojPath: '', ctx: 8192, imageTokens: 1024 };
    return {
      enabled: true,
      modelPath: preset.models?.vlmModel || '',
      mmprojPath: preset.models?.mmproj || '',
      ctx: preset.settings?.ctx || 8192,
      imageTokens: preset.settings?.imageTokens || 1024,
    };
  },

  /**
   * Resolve a preset for a given mode.
   * Combined presets have { fast: { settings, loras }, quality: { settings, loras } }.
   * Returns a flat object that looks like a normal preset — safe for all builders.
   */
  resolvePreset: (preset, mode) => {
    if (!preset || preset.mode !== 'combined') return preset;
    const modeData = preset[mode] || preset.quality || {};
    return {
      ...preset,
      settings: modeData.settings || preset.settings || {},
      loras: modeData.loras || preset.loras || [],
    };
  },

  /** Combine a fast + quality preset into one combined preset. Deletes originals. */
  combinePresets: (fastId, qualityId) => {
    const s = get();
    const fast = s.presets.find(p => p.id === fastId);
    const quality = s.presets.find(p => p.id === qualityId);
    if (!fast || !quality) return null;

    const combined = {
      id: `preset_${Date.now()}`,
      name: fast.name.replace(/\s*(fast|quick|speed)/i, '').trim() || fast.name,
      description: fast.description || quality.description || '',
      type: fast.type,
      family: fast.family,
      workflow: fast.workflow || quality.workflow || '',
      mode: 'combined',
      modelType: fast.modelType || quality.modelType || '',
      models: { ...quality.models, ...fast.models },
      negPrompt: fast.negPrompt || quality.negPrompt || '',
      backupPreset: fast.backupPreset || quality.backupPreset || '',
      linkedLoraIds: [...new Set([...(fast.linkedLoraIds || []), ...(quality.linkedLoraIds || [])])],
      fast: {
        settings: fast.settings || {},
        loras: fast.loras || [],
      },
      quality: {
        settings: quality.settings || {},
        loras: quality.loras || [],
      },
    };

    set(s => ({
      presets: [...s.presets.filter(p => p.id !== fastId && p.id !== qualityId), combined],
    }));

    // Update selectedPresets to point to combined
    const sel = { ...get().selectedPresets };
    for (const mode of ['fast', 'quality']) {
      for (const slot of Object.keys(sel[mode] || {})) {
        if (sel[mode][slot] === fastId || sel[mode][slot] === qualityId) {
          sel[mode][slot] = combined.id;
        }
      }
    }
    set({ selectedPresets: sel });

    return combined;
  },

  /** Split a combined preset back into fast + quality. Deletes the combined. */
  splitPreset: (id) => {
    const s = get();
    const combined = s.presets.find(p => p.id === id);
    if (!combined || combined.mode !== 'combined') return null;

    const shared = {
      type: combined.type, family: combined.family, workflow: combined.workflow,
      models: combined.models, negPrompt: combined.negPrompt, modelType: combined.modelType,
      description: combined.description || '',
      backupPreset: combined.backupPreset, linkedLoraIds: [...(combined.linkedLoraIds || [])],
    };

    const fastPreset = {
      ...shared, id: `preset_${Date.now()}`, name: `${combined.name} Fast`,
      mode: 'fast', settings: combined.fast?.settings || {}, loras: combined.fast?.loras || [],
    };
    const qualityPreset = {
      ...shared, id: `preset_${Date.now() + 1}`, name: `${combined.name} Quality`,
      mode: 'quality', settings: combined.quality?.settings || {}, loras: combined.quality?.loras || [],
    };

    set(s => ({
      presets: [...s.presets.filter(p => p.id !== id), fastPreset, qualityPreset],
    }));

    // Update selectedPresets
    const sel = { ...get().selectedPresets };
    for (const slot of Object.keys(sel.fast || {})) {
      if (sel.fast[slot] === id) sel.fast[slot] = fastPreset.id;
    }
    for (const slot of Object.keys(sel.quality || {})) {
      if (sel.quality[slot] === id) sel.quality[slot] = qualityPreset.id;
    }
    set({ selectedPresets: sel });

    return { fast: fastPreset, quality: qualityPreset };
  },

  // ── Persistence ──

  loadPersistedState: (data) => {
    if (data.presets) set({ presets: data.presets });
    if (data.loraPresets) set({ loraPresets: data.loraPresets });
    if (data.requiredModels) set({ requiredModels: data.requiredModels });
    if (data.separateVideoPresets !== undefined) set({ separateVideoPresets: data.separateVideoPresets });
    if (data.selectedPresets) set({ selectedPresets: data.selectedPresets });
  },

  getPersistedState: () => {
    const s = get();
    return {
      presets: s.presets,
      loraPresets: s.loraPresets,
      requiredModels: s.requiredModels,
      separateVideoPresets: s.separateVideoPresets,
      selectedPresets: s.selectedPresets,
    };
  },
}));

// Auto-persist on changes
const PERSIST_KEYS = ['presets', 'loraPresets', 'requiredModels', 'separateVideoPresets', 'selectedPresets'];
usePresetStore.subscribe((state, prev) => {
  const changed = PERSIST_KEYS.some(k => state[k] !== prev[k]);
  if (changed && window.electronAPI?.saveSettings) {
    const current = usePresetStore.getState().getPersistedState();
    window.electronAPI.loadSettings?.().then(data => {
      window.electronAPI.saveSettings({ ...data, ...current });
    });
  }
});

export default usePresetStore;
