// Unit tests for src/lib/pipeline/estimator.js — pure "how much time is left"
// calculator. The old inline version had subtle branches (return null vs.
// returning {remaining:0}) that could easily drift if someone touched the
// shape. These tests pin the contract.

import { describe, it, expect } from 'vitest';
import { computeEstimate } from '../src/lib/pipeline/estimator.js';

describe('computeEstimate', () => {
  const pending = (type) => ({ type, status: 'pending' });
  const done = (type) => ({ type, status: 'done' });

  it('returns null when there is no VLM data yet', () => {
    const r = computeEstimate({
      segments: [pending('i2v')], completedIndex: -1,
      avgVlm: null, avgImage: 30, avgI2v: 120, avgExtend: 120,
      useBodyFix: false, avgBodyfix: null,
      useHireFix: false, avgHirefix: null,
    });
    expect(r).toBeNull();
  });

  it('returns null when no generation type has data yet', () => {
    const r = computeEstimate({
      segments: [pending('extend')], completedIndex: -1,
      avgVlm: 5, avgImage: null, avgI2v: null, avgExtend: null,
      useBodyFix: false, useHireFix: false,
    });
    expect(r).toBeNull();
  });

  it('skips already-done segments', () => {
    const segs = [done('i2v'), pending('extend')];
    const r = computeEstimate({
      segments: segs, completedIndex: 0,
      avgVlm: 5, avgImage: null, avgI2v: 120, avgExtend: 30,
      useBodyFix: false, useHireFix: false,
    });
    // Only the pending extend: vlm 5 + extend 30 = 35s → under a minute
    expect(r.remaining).toBe(35);
    expect(r.text).toBe('~35s remaining');
  });

  it('returns null once nothing remains', () => {
    const r = computeEstimate({
      segments: [done('i2v')], completedIndex: 0,
      avgVlm: 5, avgImage: 30, avgI2v: 120, avgExtend: 120,
      useBodyFix: false, useHireFix: false,
    });
    expect(r).toBeNull();
  });

  it('formats as minutes when >= 2 minutes remain', () => {
    const segs = [pending('extend'), pending('extend'), pending('extend')];
    const r = computeEstimate({
      segments: segs, completedIndex: -1,
      avgVlm: 10, avgImage: null, avgI2v: null, avgExtend: 120,
      useBodyFix: false, useHireFix: false,
    });
    // 3 * (10 + 120) = 390s → 7 minutes (ceil)
    expect(r.remaining).toBe(390);
    expect(r.text).toBe('~7 min remaining');
  });

  it('adds body-fix and hirefix only on image segments and only when enabled', () => {
    const segs = [pending('image'), pending('extend')];
    const noPost = computeEstimate({
      segments: segs, completedIndex: -1,
      avgVlm: 10, avgImage: 30, avgI2v: 120, avgExtend: 60,
      useBodyFix: false, avgBodyfix: 20,
      useHireFix: false, avgHirefix: 25,
    });
    const withPost = computeEstimate({
      segments: segs, completedIndex: -1,
      avgVlm: 10, avgImage: 30, avgI2v: 120, avgExtend: 60,
      useBodyFix: true, avgBodyfix: 20,
      useHireFix: true, avgHirefix: 25,
    });
    // noPost: (10+30) + (10+60) = 110
    // withPost: (10+30+20+25) + (10+60) = 155 (no post on extend)
    expect(noPost.remaining).toBe(110);
    expect(withPost.remaining).toBe(155);
  });

  it('uses conservative defaults when an average is 0 but not null', () => {
    // 0 !== null, so hasEnoughData is true, and the `|| default` guards kick in.
    const r = computeEstimate({
      segments: [pending('i2v')], completedIndex: -1,
      avgVlm: 0, avgImage: 30, avgI2v: 0, avgExtend: 120,
      useBodyFix: false, useHireFix: false,
    });
    // vlm default 10 + i2v default 120 = 130
    expect(r.remaining).toBe(130);
  });
});
