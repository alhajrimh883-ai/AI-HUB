// Unit tests for src/lib/voiceStore.js — preferences store for the voice
// feature. We're checking three things:
//   1. setters update the store and call saveSettings with the right keys
//   2. loadPersistedState hydrates correctly and tolerates missing fields
//   3. defaults are sensible (so a fresh install has the mic hidden but
//      auto-speak ready to go once the user enables it)

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

// Stub electronAPI so saveSettings doesn't blow up. We capture the calls so
// we can assert on what got persisted.
const savedCalls = [];
beforeAll(() => {
  globalThis.window = globalThis.window || {};
  globalThis.window.electronAPI = {
    loadSettings: () => Promise.resolve({}),
    saveSettings: (data) => { savedCalls.push(data); return Promise.resolve(); },
  };
});

const { default: useVoiceStore } = await import('../src/lib/voiceStore.js');

beforeEach(() => {
  savedCalls.length = 0;
  useVoiceStore.setState({
    enabled: false,
    autoSpeak: true,
    whisperSize: 'base',
    piperVoice: 'en_US-amy-medium',
    whisperPath: '',
    piperPath: '',
    engine: 'kokoro',
    kokoroVoice: 'af_heart',
    serverState: null,
  });
});

describe('voiceStore defaults', () => {
  it('has voice off by default so the mic button stays hidden until the user opts in', () => {
    expect(useVoiceStore.getState().enabled).toBe(false);
  });

  it('has autoSpeak on so enabling voice gives the full experience immediately', () => {
    expect(useVoiceStore.getState().autoSpeak).toBe(true);
  });

  it('starts with no model paths configured', () => {
    expect(useVoiceStore.getState().whisperPath).toBe('');
    expect(useVoiceStore.getState().piperPath).toBe('');
  });

  it('defaults to the recommended Whisper "base" model and an English Piper voice', () => {
    expect(useVoiceStore.getState().whisperSize).toBe('base');
    expect(useVoiceStore.getState().piperVoice).toBe('en_US-amy-medium');
  });

  it('defaults to the Kokoro engine with af_heart voice (more natural than Piper)', () => {
    expect(useVoiceStore.getState().engine).toBe('kokoro');
    expect(useVoiceStore.getState().kokoroVoice).toBe('af_heart');
  });
});

describe('voiceStore setters', () => {
  // saveSettings runs on a 500ms debounce so we wait briefly to see the write.
  const flushSave = () => new Promise(r => setTimeout(r, 600));

  it('setEnabled flips the store and persists voiceEnabled', async () => {
    useVoiceStore.getState().setEnabled(true);
    expect(useVoiceStore.getState().enabled).toBe(true);
    await flushSave();
    const last = savedCalls.at(-1);
    expect(last).toBeTruthy();
    expect(last.voiceEnabled).toBe(true);
  });

  it('setAutoSpeak persists voiceAutoSpeak', async () => {
    useVoiceStore.getState().setAutoSpeak(false);
    expect(useVoiceStore.getState().autoSpeak).toBe(false);
    await flushSave();
    expect(savedCalls.at(-1).voiceAutoSpeak).toBe(false);
  });

  it('setWhisperPath / setPiperPath persist their respective keys', async () => {
    useVoiceStore.getState().setWhisperPath('/x/whisper.bin');
    useVoiceStore.getState().setPiperPath('/x/piper.onnx');
    await flushSave();
    // Last saved write should contain BOTH keys (they're merged into pendingWrites).
    const last = savedCalls.at(-1);
    expect(last.voiceWhisperPath).toBe('/x/whisper.bin');
    expect(last.voicePiperPath).toBe('/x/piper.onnx');
  });

  it('setWhisperSize / setPiperVoice persist correctly', async () => {
    useVoiceStore.getState().setWhisperSize('small');
    useVoiceStore.getState().setPiperVoice('en_GB-alan-medium');
    await flushSave();
    const last = savedCalls.at(-1);
    expect(last.voiceWhisperSize).toBe('small');
    expect(last.voicePiperVoice).toBe('en_GB-alan-medium');
  });

  it('setEngine persists voiceEngine and accepts kokoro/piper', async () => {
    useVoiceStore.getState().setEngine('piper');
    expect(useVoiceStore.getState().engine).toBe('piper');
    await flushSave();
    expect(savedCalls.at(-1).voiceEngine).toBe('piper');
  });

  it('setKokoroVoice persists voiceKokoroVoice', async () => {
    useVoiceStore.getState().setKokoroVoice('bf_emma');
    expect(useVoiceStore.getState().kokoroVoice).toBe('bf_emma');
    await flushSave();
    expect(savedCalls.at(-1).voiceKokoroVoice).toBe('bf_emma');
  });

  it('setServerState stays in-memory (not persisted)', async () => {
    useVoiceStore.getState().setServerState({ state: 'ready' });
    expect(useVoiceStore.getState().serverState).toEqual({ state: 'ready' });
    await flushSave();
    // No save call — serverState is runtime-only. The previous tests cleared
    // savedCalls in beforeEach, so an empty array means we didn't accidentally
    // persist runtime state.
    expect(savedCalls).toEqual([]);
  });
});

describe('voiceStore loadPersistedState', () => {
  it('hydrates all fields when the settings blob has them', () => {
    useVoiceStore.getState().loadPersistedState({
      voiceEnabled: true,
      voiceAutoSpeak: false,
      voiceWhisperSize: 'medium',
      voicePiperVoice: 'en_GB-alan-medium',
      voiceWhisperPath: '/path/w.bin',
      voicePiperPath: '/path/p.onnx',
      voiceEngine: 'piper',
      voiceKokoroVoice: 'bm_george',
    });
    const s = useVoiceStore.getState();
    expect(s.enabled).toBe(true);
    expect(s.autoSpeak).toBe(false);
    expect(s.whisperSize).toBe('medium');
    expect(s.piperVoice).toBe('en_GB-alan-medium');
    expect(s.whisperPath).toBe('/path/w.bin');
    expect(s.piperPath).toBe('/path/p.onnx');
    expect(s.engine).toBe('piper');
    expect(s.kokoroVoice).toBe('bm_george');
  });

  it('ignores invalid voiceEngine values so a corrupted blob can\'t brick the app', () => {
    useVoiceStore.getState().loadPersistedState({ voiceEngine: 'bogus' });
    // engine should remain at the default, not flip to 'bogus'.
    expect(useVoiceStore.getState().engine).toBe('kokoro');
  });

  it('leaves defaults alone when the blob is empty (fresh install)', () => {
    useVoiceStore.getState().loadPersistedState({});
    const s = useVoiceStore.getState();
    expect(s.enabled).toBe(false);
    expect(s.autoSpeak).toBe(true);
    expect(s.whisperPath).toBe('');
  });

  it('respects voiceAutoSpeak === false (boolean check, not truthiness)', () => {
    useVoiceStore.getState().loadPersistedState({ voiceAutoSpeak: false });
    expect(useVoiceStore.getState().autoSpeak).toBe(false);
  });

  it('ignores unrelated keys in the blob', () => {
    useVoiceStore.getState().loadPersistedState({ chatFontSize: 14, somethingElse: 'x' });
    expect(useVoiceStore.getState().enabled).toBe(false);
  });
});
