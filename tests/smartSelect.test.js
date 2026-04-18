// Unit tests for src/lib/smartSelect.js — focused on the VLM response
// validation path, which is where bad model output silently turns into
// wrong selections. Also covers the app-management pieces (filter, batch).

import { describe, it, expect, vi } from 'vitest';
import {
  smartSelect,
  canSmartSelect,
  filterPresets,
  selectPreset,
  selectLoras,
} from '../src/lib/smartSelect.js';

// ─── filterPresets ───────────────────────────────────────────────────

describe('filterPresets', () => {
  const presets = [
    { id: '1', type: 't2i', mode: 'fast' },
    { id: '2', type: 't2i', mode: 'quality' },
    { id: '3', type: 't2i', mode: 'both' },
    { id: '4', type: 't2i', mode: 'combined' },
    { id: '5', type: 'video', mode: 'fast' },
  ];

  it('filters by type and mode, keeping "both" and "combined"', () => {
    const fast = filterPresets(presets, 't2i', 'fast');
    const ids = fast.map(p => p.id).sort();
    expect(ids).toEqual(['1', '3', '4']);
  });

  it('only returns presets of the requested type', () => {
    const videoFast = filterPresets(presets, 'video', 'fast');
    expect(videoFast.length).toBe(1);
    expect(videoFast[0].id).toBe('5');
  });

  it('returns [] when no presets match', () => {
    expect(filterPresets(presets, 'edit', 'fast')).toEqual([]);
  });
});

// ─── canSmartSelect ──────────────────────────────────────────────────

describe('canSmartSelect', () => {
  it('returns false with zero or one candidate', () => {
    expect(canSmartSelect([], 't2i', 'fast')).toBe(false);
    expect(canSmartSelect([{ type: 't2i', mode: 'fast' }], 't2i', 'fast')).toBe(false);
  });

  it('returns true when multiple candidates exist', () => {
    const presets = [
      { type: 't2i', mode: 'fast' },
      { type: 't2i', mode: 'both' },
    ];
    expect(canSmartSelect(presets, 't2i', 'fast')).toBe(true);
  });
});

// ─── selectPreset ────────────────────────────────────────────────────

describe('selectPreset', () => {
  const presets = [
    { id: 'a', name: 'A', type: 't2i', mode: 'fast' },
    { id: 'b', name: 'B', type: 't2i', mode: 'fast' },
    { id: 'c', name: 'C', type: 't2i', mode: 'fast' },
  ];

  it('returns null when no presets of the requested type/mode exist', async () => {
    const result = await selectPreset({ prompt: 'x', type: 'video', mode: 'fast', presets, infer: null });
    expect(result).toBeNull();
  });

  it('returns the only match without calling the VLM', async () => {
    const infer = vi.fn();
    const result = await selectPreset({
      prompt: 'x', type: 't2i', mode: 'fast',
      presets: [presets[0]], infer,
    });
    expect(result.preset.id).toBe('a');
    expect(infer).not.toHaveBeenCalled();
  });

  it('falls back to the first preset when infer is null', async () => {
    const result = await selectPreset({ prompt: 'x', type: 't2i', mode: 'fast', presets, infer: null });
    expect(result.preset.id).toBe('a');
  });

  it('parses valid VLM JSON and returns the picked preset', async () => {
    const infer = vi.fn().mockResolvedValue('{"pick": 2, "reason": "matches best"}');
    const result = await selectPreset({ prompt: 'x', type: 't2i', mode: 'fast', presets, infer });
    expect(result.preset.id).toBe('b');
    expect(result.reasoning).toBe('matches best');
  });

  it('tolerates VLM responses with surrounding noise and <think> blocks', async () => {
    const infer = vi.fn().mockResolvedValue('<think>hmm</think> ok here: {"pick": 3, "reason": "third wins"}  (done)');
    const result = await selectPreset({ prompt: 'x', type: 't2i', mode: 'fast', presets, infer });
    expect(result.preset.id).toBe('c');
  });

  it('falls back to the first preset when VLM returns junk', async () => {
    const infer = vi.fn().mockResolvedValue('I am not JSON at all.');
    const result = await selectPreset({ prompt: 'x', type: 't2i', mode: 'fast', presets, infer });
    expect(result.preset.id).toBe('a');
  });

  it('falls back when VLM picks an out-of-range number', async () => {
    const infer = vi.fn().mockResolvedValue('{"pick": 99, "reason": "nope"}');
    const result = await selectPreset({ prompt: 'x', type: 't2i', mode: 'fast', presets, infer });
    expect(result.preset.id).toBe('a');
  });

  it('falls back when VLM call throws', async () => {
    const infer = vi.fn().mockRejectedValue(new Error('server down'));
    const result = await selectPreset({ prompt: 'x', type: 't2i', mode: 'fast', presets, infer });
    expect(result.preset.id).toBe('a');
  });
});

// ─── selectLoras ─────────────────────────────────────────────────────

describe('selectLoras', () => {
  const pool = [
    { id: 'l1', name: 'Style' },
    { id: 'l2', name: 'Pose' },
    { id: 'l3', name: 'Detail' },
  ];

  it('returns [] when the preset has no linked LoRAs', async () => {
    const result = await selectLoras({
      prompt: 'x', preset: { id: 'p', linkedLoraIds: [] },
      loraPresets: pool, infer: null,
    });
    expect(result.loras).toEqual([]);
  });

  it('returns [] when linked IDs resolve to nothing', async () => {
    const result = await selectLoras({
      prompt: 'x', preset: { id: 'p', linkedLoraIds: ['ghost'] },
      loraPresets: pool, infer: null,
    });
    expect(result.loras).toEqual([]);
  });

  it('returns all linked LoRAs when no VLM is provided', async () => {
    const result = await selectLoras({
      prompt: 'x', preset: { id: 'p', linkedLoraIds: ['l1', 'l3'] },
      loraPresets: pool, infer: null,
    });
    expect(result.loras.map(l => l.name).sort()).toEqual(['Detail', 'Style']);
  });

  it('parses VLM JSON and returns only picked LoRAs', async () => {
    const infer = vi.fn().mockResolvedValue('{"picks": [1, 3], "reason": "style + detail"}');
    const result = await selectLoras({
      prompt: 'x', preset: { id: 'p', linkedLoraIds: ['l1', 'l2', 'l3'] },
      loraPresets: pool, infer,
    });
    const names = result.loras.map(l => l.name).sort();
    expect(names).toEqual(['Detail', 'Style']);
  });

  it('handles empty picks array as "none of these fit"', async () => {
    const infer = vi.fn().mockResolvedValue('{"picks": [], "reason": "none fit"}');
    const result = await selectLoras({
      prompt: 'x', preset: { id: 'p', linkedLoraIds: ['l1', 'l2'] },
      loraPresets: pool, infer,
    });
    expect(result.loras).toEqual([]);
  });

  it('returns [] when VLM returns malformed JSON', async () => {
    const infer = vi.fn().mockResolvedValue('garbage no json');
    const result = await selectLoras({
      prompt: 'x', preset: { id: 'p', linkedLoraIds: ['l1', 'l2'] },
      loraPresets: pool, infer,
    });
    expect(result.loras).toEqual([]);
  });

  it('batches large LoRA lists and aggregates picks across batches', async () => {
    // Make a linked list of 20 LoRAs so it crosses the BATCH_SIZE=8 threshold
    const pool20 = Array.from({ length: 20 }, (_, i) => ({ id: `l${i}`, name: `L${i}` }));
    const linkedIds = pool20.map(l => l.id);
    // VLM: always pick the first one in each batch
    const infer = vi.fn().mockResolvedValue('{"picks": [1], "reason": "ok"}');
    const result = await selectLoras({
      prompt: 'x', preset: { id: 'p', linkedLoraIds: linkedIds },
      loraPresets: pool20, infer,
    });
    // 20 LoRAs / 8 per batch = 3 batches, so 3 picks total
    expect(infer).toHaveBeenCalledTimes(3);
    expect(result.loras.length).toBe(3);
  });
});

// ─── End-to-end smartSelect ──────────────────────────────────────────

describe('smartSelect (end-to-end)', () => {
  it('returns null when prompt is empty', async () => {
    const result = await smartSelect({
      prompt: '', type: 't2i', mode: 'fast',
      presets: [], loraPresets: [],
    });
    expect(result).toBeNull();
  });

  it('chains preset selection then LoRA selection', async () => {
    const presets = [
      { id: 'p1', name: 'Cinematic', type: 't2i', mode: 'fast', linkedLoraIds: ['l1'] },
      { id: 'p2', name: 'Anime', type: 't2i', mode: 'fast', linkedLoraIds: [] },
    ];
    const loraPresets = [{ id: 'l1', name: 'Film Grain' }];
    let callNum = 0;
    const infer = vi.fn().mockImplementation(async () => {
      callNum++;
      if (callNum === 1) return '{"pick": 1, "reason": "cinematic fits"}';
      return '{"picks": [1], "reason": "grain fits"}';
    });
    const result = await smartSelect({
      prompt: 'a cinematic portrait', type: 't2i', mode: 'fast',
      presets, loraPresets, infer,
    });
    expect(result.preset.id).toBe('p1');
    expect(result.loras.length).toBe(1);
    expect(result.loras[0].id).toBe('l1');
    expect(result.reasoning.preset).toBe('cinematic fits');
  });
});
