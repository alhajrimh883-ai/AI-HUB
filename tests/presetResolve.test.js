// Unit tests for src/lib/presetStore.js — focused on the resolution logic
// (combined presets, LoRA Pool linkage, getSelectedPreset). Persistence and
// the zustand subscription to window.electronAPI are not exercised here; we
// only test the pure-ish getters and reducers.

import { describe, it, expect, beforeEach, beforeAll } from 'vitest';

// The store's auto-persist subscription touches `window.electronAPI`. In a
// node-environment test run, `window` is undefined — stub it so imports work.
beforeAll(() => {
  globalThis.window = globalThis.window || {};
});

// Import the store AFTER window is stubbed so the subscription setup is safe.
const { default: usePresetStore } = await import('../src/lib/presetStore.js');

// Reset store state to a clean baseline before every test.
beforeEach(() => {
  usePresetStore.setState({
    presets: [],
    loraPresets: [],
    requiredModels: {},
    separateVideoPresets: false,
    selectedPresets: { fast: {}, quality: {}, both: {} },
  });
});

// ─── resolvePreset ───────────────────────────────────────────────────

describe('resolvePreset', () => {
  it('returns non-combined presets unchanged', () => {
    const preset = { id: 'a', mode: 'fast', settings: { steps: 4 }, loras: [{ name: 'x' }] };
    const resolved = usePresetStore.getState().resolvePreset(preset, 'fast');
    expect(resolved).toBe(preset);
  });

  it('flattens a combined preset to its fast variant when mode is fast', () => {
    const preset = {
      id: 'c', mode: 'combined',
      fast: { settings: { steps: 4, cfg: 1 }, loras: [{ name: 'fast_lora' }] },
      quality: { settings: { steps: 20, cfg: 7 }, loras: [{ name: 'quality_lora' }] },
    };
    const resolved = usePresetStore.getState().resolvePreset(preset, 'fast');
    expect(resolved.settings.steps).toBe(4);
    expect(resolved.settings.cfg).toBe(1);
    expect(resolved.loras[0].name).toBe('fast_lora');
  });

  it('flattens a combined preset to its quality variant when mode is quality', () => {
    const preset = {
      id: 'c', mode: 'combined',
      fast: { settings: { steps: 4 }, loras: [] },
      quality: { settings: { steps: 20 }, loras: [{ name: 'q' }] },
    };
    const resolved = usePresetStore.getState().resolvePreset(preset, 'quality');
    expect(resolved.settings.steps).toBe(20);
    expect(resolved.loras[0].name).toBe('q');
  });

  it('falls back to quality when the requested mode is missing from a combined preset', () => {
    const preset = {
      id: 'c', mode: 'combined',
      quality: { settings: { steps: 20 }, loras: [{ name: 'q' }] },
    };
    const resolved = usePresetStore.getState().resolvePreset(preset, 'fast');
    expect(resolved.settings.steps).toBe(20);
    expect(resolved.loras[0].name).toBe('q');
  });

  it('returns null when passed null', () => {
    expect(usePresetStore.getState().resolvePreset(null, 'fast')).toBe(null);
  });
});

// ─── combinePresets ──────────────────────────────────────────────────

describe('combinePresets', () => {
  it('merges two presets into one combined with fast/quality sub-objects', () => {
    const store = usePresetStore.getState();
    usePresetStore.setState({
      presets: [
        { id: 'f', name: 'My Preset Fast', type: 't2i', family: 'sdxl', mode: 'fast',
          models: { checkpoint: 'sdxl.safetensors' }, settings: { steps: 4 }, loras: [{ name: 'flash' }] },
        { id: 'q', name: 'My Preset Quality', type: 't2i', family: 'sdxl', mode: 'quality',
          models: { checkpoint: 'sdxl.safetensors' }, settings: { steps: 20 }, loras: [] },
      ],
    });
    const combined = usePresetStore.getState().combinePresets('f', 'q');
    expect(combined).not.toBeNull();
    expect(combined.mode).toBe('combined');
    expect(combined.fast.settings.steps).toBe(4);
    expect(combined.quality.settings.steps).toBe(20);
    expect(combined.fast.loras[0].name).toBe('flash');
    // Originals are removed from the store
    const ids = usePresetStore.getState().presets.map(p => p.id);
    expect(ids).not.toContain('f');
    expect(ids).not.toContain('q');
    expect(ids).toContain(combined.id);
  });

  it('returns null when either input id is missing', () => {
    usePresetStore.setState({ presets: [{ id: 'only', mode: 'fast' }] });
    expect(usePresetStore.getState().combinePresets('only', 'missing')).toBeNull();
    expect(usePresetStore.getState().combinePresets('missing', 'only')).toBeNull();
  });

  it('merges linkedLoraIds without duplicates', () => {
    usePresetStore.setState({
      presets: [
        { id: 'f', name: 'F', type: 't2i', family: 'sdxl', mode: 'fast',
          models: {}, settings: {}, loras: [], linkedLoraIds: ['l1', 'l2'] },
        { id: 'q', name: 'Q', type: 't2i', family: 'sdxl', mode: 'quality',
          models: {}, settings: {}, loras: [], linkedLoraIds: ['l2', 'l3'] },
      ],
    });
    const combined = usePresetStore.getState().combinePresets('f', 'q');
    expect(combined.linkedLoraIds.sort()).toEqual(['l1', 'l2', 'l3']);
  });
});

// ─── LoRA Pool linkage ───────────────────────────────────────────────

describe('getLinkedLoras', () => {
  it('returns [] when the preset has no linked LoRAs', () => {
    usePresetStore.setState({ presets: [{ id: 'p', linkedLoraIds: [] }] });
    expect(usePresetStore.getState().getLinkedLoras('p')).toEqual([]);
  });

  it('resolves linked LoRA IDs to full LoRA objects from the pool', () => {
    usePresetStore.setState({
      presets: [{ id: 'p', linkedLoraIds: ['l1', 'l3'] }],
      loraPresets: [
        { id: 'l1', name: 'Style' },
        { id: 'l2', name: 'Pose' },
        { id: 'l3', name: 'Detail' },
      ],
    });
    const linked = usePresetStore.getState().getLinkedLoras('p');
    expect(linked.map(l => l.name)).toEqual(['Style', 'Detail']);
  });

  it('filters out stale IDs that no longer exist in the pool', () => {
    usePresetStore.setState({
      presets: [{ id: 'p', linkedLoraIds: ['l1', 'deleted'] }],
      loraPresets: [{ id: 'l1', name: 'Style' }],
    });
    const linked = usePresetStore.getState().getLinkedLoras('p');
    expect(linked.length).toBe(1);
    expect(linked[0].name).toBe('Style');
  });
});

// ─── getSelectedPreset ───────────────────────────────────────────────

describe('getSelectedPreset', () => {
  it('returns null when nothing is selected for the slot', () => {
    expect(usePresetStore.getState().getSelectedPreset('fast', 't2i')).toBeNull();
  });

  it('returns the selected preset, resolved for the active mode', () => {
    usePresetStore.setState({
      presets: [{
        id: 'c', mode: 'combined',
        fast: { settings: { steps: 4 }, loras: [] },
        quality: { settings: { steps: 20 }, loras: [] },
      }],
      selectedPresets: { fast: { t2i: 'c' }, quality: { t2i: 'c' } },
    });
    const fastResolved = usePresetStore.getState().getSelectedPreset('fast', 't2i');
    const qualResolved = usePresetStore.getState().getSelectedPreset('quality', 't2i');
    expect(fastResolved.settings.steps).toBe(4);
    expect(qualResolved.settings.steps).toBe(20);
  });
});
