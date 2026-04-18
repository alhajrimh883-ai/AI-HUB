// Tests for src/lib/vlmOptimize.js — the shared GPU-to-profile matcher used
// by both the AppSettings Auto-Optimize button and the first-run wizard's
// VLM screen. If these two ever drift apart a user's "recommended" settings
// would silently change when they opened Settings, so we lock the mapping.

import { describe, it, expect, vi } from 'vitest';
import { getAutoOptimizeProfile, applyAutoOptimizeProfile } from '../src/lib/vlmOptimize';

describe('getAutoOptimizeProfile — GPU matching', () => {
  it('matches 8 GB class (3060/4060)', () => {
    expect(getAutoOptimizeProfile('NVIDIA GeForce RTX 3060').ctx).toBe(4096);
    expect(getAutoOptimizeProfile('NVIDIA GeForce RTX 4060 Ti').frames).toBe(2);
    expect(getAutoOptimizeProfile('rtx 4060').after).toBe('unload');
  });

  it('matches 12 GB class (3070/4070)', () => {
    const p = getAutoOptimizeProfile('NVIDIA GeForce RTX 4070');
    expect(p.ctx).toBe(8192);
    expect(p.img).toBe(512);
    expect(p.mode).toBe('single');
  });

  it('matches 16 GB class (3080/4080/5080)', () => {
    expect(getAutoOptimizeProfile('RTX 4080 SUPER').mode).toBe('multi');
    expect(getAutoOptimizeProfile('RTX 5080').img).toBe(1024);
    expect(getAutoOptimizeProfile('RTX 3080 Ti').frames).toBe(4);
  });

  it('matches 24 GB class (3090/4090)', () => {
    const p = getAutoOptimizeProfile('NVIDIA GeForce RTX 4090');
    expect(p.ctx).toBe(16384);
    expect(p.frames).toBe(6);
  });

  it('matches 32 GB class (5090)', () => {
    const p = getAutoOptimizeProfile('NVIDIA GeForce RTX 5090');
    expect(p.img).toBe(2048);
    expect(p.frames).toBe(8);
  });

  it('is case-insensitive', () => {
    expect(getAutoOptimizeProfile('rtx 4090').ctx).toBe(16384);
    expect(getAutoOptimizeProfile('RTX 4090').ctx).toBe(16384);
  });

  it('returns the conservative fallback for unknown GPUs', () => {
    const p = getAutoOptimizeProfile('Intel Arc A770');
    expect(p.ctx).toBe(8192);
    expect(p.label).toMatch(/Unknown/i);
  });

  it('returns the fallback for empty / nullish input', () => {
    expect(getAutoOptimizeProfile('').label).toMatch(/Unknown/i);
    expect(getAutoOptimizeProfile(null).label).toMatch(/Unknown/i);
    expect(getAutoOptimizeProfile(undefined).label).toMatch(/Unknown/i);
  });
});

describe('applyAutoOptimizeProfile — store setter wiring', () => {
  it('calls every setter with the matching profile field', () => {
    const setters = {
      setVlmCtx: vi.fn(),
      setVlmImageTokens: vi.fn(),
      setVlmTargetFrames: vi.fn(),
      setVlmVideoMode: vi.fn(),
      setVlmAfterInference: vi.fn(),
    };
    const profile = getAutoOptimizeProfile('RTX 4090');
    applyAutoOptimizeProfile(profile, setters);
    expect(setters.setVlmCtx).toHaveBeenCalledWith(16384);
    expect(setters.setVlmImageTokens).toHaveBeenCalledWith(1024);
    expect(setters.setVlmTargetFrames).toHaveBeenCalledWith(6);
    expect(setters.setVlmVideoMode).toHaveBeenCalledWith('multi');
    expect(setters.setVlmAfterInference).toHaveBeenCalledWith('park');
  });

  it('tolerates missing setters (optional chaining)', () => {
    const profile = getAutoOptimizeProfile('RTX 4070');
    // Pass an empty setters object — should not throw.
    expect(() => applyAutoOptimizeProfile(profile, {})).not.toThrow();
  });
});
