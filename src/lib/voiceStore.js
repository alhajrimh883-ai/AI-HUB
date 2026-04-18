/**
 * Voice Store — User-facing preferences for the voice chat feature.
 *
 * Persisted via the global settingsPersist helper (same debounced write
 * pattern other stores use). None of the heavy lifting lives here; this just
 * holds paths + toggles so Chat / Settings stay in sync and survive restarts.
 *
 * Fields:
 *   enabled        — master switch. When off, the mic button is hidden and
 *                    chatPipeline skips TTS even if autoSpeak is on.
 *   autoSpeak      — when true, chatPipeline runs TTS on the final assistant
 *                    reply so you hear it without clicking the 🔊 button.
 *   whisperSize    — which Whisper ggml preset to auto-download (tiny/base/
 *                    small/medium). Stays in sync with whisperPath.
 *   piperVoice     — same idea for Piper.
 *   whisperPath    — absolute path to the ggml .bin file the voice server
 *                    should load. May be set by the download button OR by
 *                    Browse… (hybrid model — auto-download with override).
 *   piperPath      — absolute path to the Piper .onnx file.
 *   engine         — active TTS engine: 'kokoro' (default, more natural)
 *                    or 'piper' (legacy fallback, kept for users who already
 *                    downloaded a Piper voice).
 *   kokoroVoice    — Kokoro voice name, e.g. 'af_heart' (American female,
 *                    warm). The voice_server keeps weights cached by voice;
 *                    switching is cheap.
 *   serverState    — cached status from /status, populated by pokeStatus().
 */

import { create } from 'zustand';
import { saveSettings } from './settingsPersist';

const useVoiceStore = create((set, get) => ({
  enabled: false,
  autoSpeak: true,
  whisperSize: 'base',
  piperVoice: 'en_US-amy-medium',
  whisperPath: '',
  piperPath: '',
  engine: 'kokoro',
  kokoroVoice: 'af_heart',
  serverState: null, // { state, engine, whisper: {...}, piper: {...}, kokoro: {...} } from /status

  setEnabled: (v) => { set({ enabled: v }); saveSettings({ voiceEnabled: v }); },
  setAutoSpeak: (v) => { set({ autoSpeak: v }); saveSettings({ voiceAutoSpeak: v }); },
  setWhisperSize: (v) => { set({ whisperSize: v }); saveSettings({ voiceWhisperSize: v }); },
  setPiperVoice: (v) => { set({ piperVoice: v }); saveSettings({ voicePiperVoice: v }); },
  setWhisperPath: (v) => { set({ whisperPath: v }); saveSettings({ voiceWhisperPath: v }); },
  setPiperPath: (v) => { set({ piperPath: v }); saveSettings({ voicePiperPath: v }); },
  setEngine: (v) => { set({ engine: v }); saveSettings({ voiceEngine: v }); },
  setKokoroVoice: (v) => { set({ kokoroVoice: v }); saveSettings({ voiceKokoroVoice: v }); },
  setServerState: (v) => set({ serverState: v }),

  /** Hydrate from the on-disk settings blob the app loads at boot. */
  loadPersistedState: (data) => {
    if (typeof data.voiceEnabled === 'boolean') set({ enabled: data.voiceEnabled });
    if (typeof data.voiceAutoSpeak === 'boolean') set({ autoSpeak: data.voiceAutoSpeak });
    if (data.voiceWhisperSize) set({ whisperSize: data.voiceWhisperSize });
    if (data.voicePiperVoice) set({ piperVoice: data.voicePiperVoice });
    if (data.voiceWhisperPath) set({ whisperPath: data.voiceWhisperPath });
    if (data.voicePiperPath) set({ piperPath: data.voicePiperPath });
    if (data.voiceEngine === 'kokoro' || data.voiceEngine === 'piper') set({ engine: data.voiceEngine });
    if (data.voiceKokoroVoice) set({ kokoroVoice: data.voiceKokoroVoice });
  },
}));

export default useVoiceStore;
