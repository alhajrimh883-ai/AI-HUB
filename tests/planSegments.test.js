// Unit tests for src/lib/pipeline/planSegments.js — pure function that turns
// user inputs into the array of segments the Director will generate. If this
// regresses, the app silently produces the wrong number of clips or skips the
// T2I kickoff when it shouldn't.

import { describe, it, expect } from 'vitest';
import { planSegments } from '../src/lib/pipeline/planSegments.js';

describe('planSegments', () => {
  const base = {
    targetLength: 10,
    segmentDuration: 5,
    resetEnabled: false,
    resetInterval: 0,
  };

  it('errors when no input and no T2I preset is selected', () => {
    const r = planSegments({ ...base, hasImage: false, hasVideo: false, hasT2IPreset: false });
    expect(r.error).toMatch(/T2I preset/i);
    expect(r.segments).toBeUndefined();
  });

  it('text-only start: image then i2v then extends', () => {
    // targetLength 10, segmentDuration 5 → totalVideoSegs = 2.
    // image + i2v consumes 1 video seg, so extends = 1.
    const r = planSegments({ ...base, hasImage: false, hasVideo: false, hasT2IPreset: true });
    expect(r.error).toBeUndefined();
    const types = r.segments.map(s => s.type);
    expect(types).toEqual(['image', 'i2v', 'extend']);
  });

  it('image start: i2v then extends, no initial image segment', () => {
    const r = planSegments({ ...base, hasImage: true, hasVideo: false });
    const types = r.segments.map(s => s.type);
    expect(types[0]).toBe('i2v');
    expect(types.slice(1).every(t => t === 'extend' || t === 'reset')).toBe(true);
  });

  it('video start: only extends', () => {
    // targetLength 15, segmentDuration 5 → totalVideoSegs = 3. All extends.
    const r = planSegments({ ...base, targetLength: 15, hasImage: false, hasVideo: true });
    const types = r.segments.map(s => s.type);
    expect(types).toEqual(['extend', 'extend', 'extend']);
  });

  it('injects reset segments at the configured interval', () => {
    // targetLength 25, segmentDuration 5 → 5 extends. resetInterval=2 means
    // positions 2 and 4 (within the extend loop, 0-indexed) become resets.
    const r = planSegments({
      ...base,
      targetLength: 25,
      hasImage: false,
      hasVideo: true,
      resetEnabled: true,
      resetInterval: 2,
    });
    const types = r.segments.map(s => s.type);
    expect(types.length).toBe(5);
    expect(types[0]).toBe('extend');
    expect(types[2]).toBe('reset');
    expect(types[4]).toBe('reset');
  });

  it('does not make the first extend a reset even if the interval would land on it', () => {
    const r = planSegments({
      ...base, hasImage: false, hasVideo: true,
      targetLength: 15, resetEnabled: true, resetInterval: 1,
    });
    const types = r.segments.map(s => s.type);
    expect(types[0]).toBe('extend'); // i === 0 never resets, by design
  });

  it('clamps to at least 1 video segment even for tiny target length', () => {
    const r = planSegments({
      ...base, hasImage: true, hasVideo: false,
      targetLength: 1, segmentDuration: 5,
    });
    // Math.max(1, ceil(1/5)) = 1 total, minus i2v = 0 extends
    expect(r.segments.length).toBe(1);
    expect(r.segments[0].type).toBe('i2v');
  });

  it('every segment has the expected shape', () => {
    const r = planSegments({ ...base, hasImage: false, hasVideo: false, hasT2IPreset: true });
    for (const seg of r.segments) {
      expect(seg).toHaveProperty('id');
      expect(seg).toHaveProperty('type');
      expect(seg.status).toBe('pending');
      expect(seg.prompt).toBe('');
      expect(seg.result).toBeNull();
    }
  });
});
