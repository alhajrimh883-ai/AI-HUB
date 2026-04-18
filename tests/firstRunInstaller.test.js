// Tests for src/lib/firstRunInstaller.js — the orchestrator that runs all
// the first-launch installs in one go. We stub window.electronAPI and the
// voice client so we can assert on:
//   1. steps are called in the documented order
//   2. onStep / onLog / onProgress callbacks fire correctly
//   3. a failure in the middle aborts the remaining steps and reports the
//      partial `completed` list (so the UI can show where we stopped)
//   4. Python path defaults to 'python' when detection returns nothing
//   5. voice server /status polling actually waits for the server to come up
//
// This is a renderer-side module, so we poke the happy path + the main
// failure paths rather than every combinatoric branch.

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── Mocks ─────────────────────────────────────────────────────────
// voiceClient is mocked so getVoiceStatus / downloadWhisper / downloadKokoro
// don't hit real HTTP endpoints. vi.mock must come before the import of the
// installer itself.
vi.mock('../src/lib/voiceClient.js', () => ({
  getVoiceStatus: vi.fn(() => Promise.resolve({ ok: true })),
  downloadWhisper: vi.fn(() => Promise.resolve({ path: '/x/whisper.bin', cached: false })),
  downloadKokoro: vi.fn(() => Promise.resolve({ cached: false })),
}));

import { runFirstRunInstall, getFirstRunSteps } from '../src/lib/firstRunInstaller';
import * as voice from '../src/lib/voiceClient';

// Minimal electronAPI stub — every call resolves with { ok: true } unless
// a test overrides individual methods.
function makeElectronAPI(overrides = {}) {
  const base = {
    detectPython: vi.fn(() => Promise.resolve({ path: '/usr/bin/python3' })),
    vlmSetup:     vi.fn(() => Promise.resolve({ ok: true })),
    voiceSetup:   vi.fn(() => Promise.resolve({ ok: true })),
    voiceStart:   vi.fn(() => Promise.resolve({ ok: true })),
  };
  return { ...base, ...overrides };
}

beforeEach(() => {
  globalThis.window = globalThis.window || {};
  globalThis.window.electronAPI = makeElectronAPI();
  vi.clearAllMocks();
  // Re-stub the voice mocks to defaults so tests can override per-case.
  voice.getVoiceStatus.mockResolvedValue({ ok: true });
  voice.downloadWhisper.mockResolvedValue({ path: '/x/whisper.bin', cached: false });
  voice.downloadKokoro.mockResolvedValue({ cached: false });
});

describe('firstRunInstaller — getFirstRunSteps', () => {
  it('lists the 6 documented steps in order', () => {
    const steps = getFirstRunSteps();
    expect(steps.map(s => s.id)).toEqual(['python', 'vlm', 'voice', 'start', 'whisper', 'kokoro']);
  });

  it('every step has a non-empty label', () => {
    for (const s of getFirstRunSteps()) expect(s.label).toBeTruthy();
  });

  it('returns fresh copies so the caller can mutate without side-effects', () => {
    const a = getFirstRunSteps();
    a[0].label = 'mutated';
    const b = getFirstRunSteps();
    expect(b[0].label).not.toBe('mutated');
  });
});

describe('firstRunInstaller — happy path', () => {
  it('runs every step and returns { ok: true, completed: [all 6] }', async () => {
    const result = await runFirstRunInstall();
    expect(result.ok).toBe(true);
    expect(result.completed).toEqual(['python', 'vlm', 'voice', 'start', 'whisper', 'kokoro']);
  });

  it('fires onStep(running) then onStep(done) for each step, in order', async () => {
    const calls = [];
    await runFirstRunInstall({ onStep: (id, status) => calls.push([id, status]) });
    // Each step should have a running-before-done pair.
    const ids = ['python', 'vlm', 'voice', 'start', 'whisper', 'kokoro'];
    for (const id of ids) {
      const running = calls.findIndex(([i, s]) => i === id && s === 'running');
      const done    = calls.findIndex(([i, s]) => i === id && s === 'done');
      expect(running).toBeGreaterThan(-1);
      expect(done).toBeGreaterThan(running);
    }
  });

  it('onProgress hits 100 at the end', async () => {
    const pcts = [];
    await runFirstRunInstall({ onProgress: (p) => pcts.push(p) });
    expect(pcts.at(-1)).toBe(100);
    // Monotonic (progress never goes backwards).
    for (let i = 1; i < pcts.length; i++) expect(pcts[i]).toBeGreaterThanOrEqual(pcts[i - 1]);
  });

  it('onLog receives at least one line per step', async () => {
    const lines = [];
    await runFirstRunInstall({ onLog: (l) => lines.push(l) });
    // Starts with an arrow for each step; there are 6 steps so ≥6 lines.
    const arrowLines = lines.filter(l => l.startsWith('→'));
    expect(arrowLines.length).toBe(6);
  });

  it('defaults to Python "python" when detection returns nothing', async () => {
    window.electronAPI.detectPython = vi.fn(() => Promise.resolve(null));
    await runFirstRunInstall();
    // vlmSetup should have been called with pythonPath: 'python' as the
    // fallback (not null / undefined).
    expect(window.electronAPI.vlmSetup).toHaveBeenCalledWith({ pythonPath: 'python' });
  });

  it('passes the user-supplied pythonPath through to every step', async () => {
    await runFirstRunInstall({ pythonPath: '/opt/python/bin/python' });
    expect(window.electronAPI.vlmSetup).toHaveBeenCalledWith({ pythonPath: '/opt/python/bin/python' });
    expect(window.electronAPI.voiceSetup).toHaveBeenCalledWith({ pythonPath: '/opt/python/bin/python' });
    expect(window.electronAPI.voiceStart).toHaveBeenCalledWith({ pythonPath: '/opt/python/bin/python' });
  });
});

describe('firstRunInstaller — failure handling', () => {
  it('aborts on the first failing step and returns the partial completed list', async () => {
    window.electronAPI.voiceSetup = vi.fn(() => Promise.resolve({ error: 'pip ran out of disk' }));
    const result = await runFirstRunInstall();
    expect(result.ok).toBe(false);
    // python + vlm succeeded; voice failed; start/whisper/kokoro never ran.
    expect(result.completed).toEqual(['python', 'vlm']);
    expect(result.error).toMatch(/pip ran out of disk/);
    expect(window.electronAPI.voiceStart).not.toHaveBeenCalled();
  });

  it('reports an error when vlmSetup returns { error }', async () => {
    window.electronAPI.vlmSetup = vi.fn(() => Promise.resolve({ error: 'no wheel for arm64' }));
    const result = await runFirstRunInstall();
    expect(result.ok).toBe(false);
    expect(result.completed).toEqual(['python']);
    expect(result.error).toMatch(/no wheel/);
  });

  it('fires onStep(error, message) for the failing step', async () => {
    window.electronAPI.voiceSetup = vi.fn(() => Promise.resolve({ error: 'nope' }));
    const stepCalls = [];
    await runFirstRunInstall({ onStep: (id, status, msg) => stepCalls.push([id, status, msg]) });
    const errCall = stepCalls.find(([id, status]) => id === 'voice' && status === 'error');
    expect(errCall).toBeTruthy();
    expect(errCall[2]).toMatch(/nope/);
  });

  it('handles missing window.electronAPI gracefully', async () => {
    delete globalThis.window.electronAPI;
    const result = await runFirstRunInstall();
    expect(result.ok).toBe(false);
    expect(result.completed).toEqual([]);
    expect(result.error).toMatch(/not running in electron/i);
    // Restore for other tests.
    globalThis.window.electronAPI = makeElectronAPI();
  });
});

describe('firstRunInstaller — server readiness', () => {
  it('polls getVoiceStatus until the server comes up', async () => {
    // Fail the first 3 status probes, then succeed.
    let calls = 0;
    voice.getVoiceStatus.mockImplementation(() => {
      calls++;
      if (calls <= 3) return Promise.reject(new Error('connection refused'));
      return Promise.resolve({ ok: true });
    });
    const result = await runFirstRunInstall();
    expect(result.ok).toBe(true);
    expect(calls).toBeGreaterThan(3);
  });

  it('gives up after too many probes and fails the start step', async () => {
    voice.getVoiceStatus.mockImplementation(() => Promise.reject(new Error('still down')));
    const result = await runFirstRunInstall();
    expect(result.ok).toBe(false);
    expect(result.completed).toEqual(['python', 'vlm', 'voice']);
    expect(result.error).toMatch(/voice server failed to respond/i);
  }, 15000); // allow up to 15 s — the installer polls 15 times × 500 ms.
});
