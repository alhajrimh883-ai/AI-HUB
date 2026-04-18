/**
 * Voice Client — Talks to the local Flask voice server (STT + TTS) that
 * electron/ipc/voice.js manages as a subprocess. Mirrors vlmClient's shape but
 * is lighter because the voice server keeps both models resident without a
 * park/unload dance.
 */

const VOICE_BASE = 'http://127.0.0.1:5124';

/** Cheap liveness probe — used by ensureVoiceServer before (re)spawning. */
export async function checkVoiceServer() {
  try {
    const r = await fetch(`${VOICE_BASE}/status`, { signal: AbortSignal.timeout(2000) });
    return r.ok;
  } catch { return false; }
}

export async function getVoiceStatus() {
  const r = await fetch(`${VOICE_BASE}/status`);
  return r.json();
}

/**
 * Set model paths + TTS engine on the server. Lazy-reloads on the next
 * transcribe/speak call.
 * @param {{
 *   whisper_path?: string|null,
 *   piper_path?: string|null,
 *   engine?: 'kokoro'|'piper',
 *   kokoro_voice?: string,
 * }} opts
 */
export async function setVoiceConfig(opts) {
  const r = await fetch(`${VOICE_BASE}/config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(opts),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || 'Voice config failed');
  return data;
}

/**
 * Speech-to-text. Caller supplies a base64-encoded WAV blob; server decodes,
 * resamples to 16kHz mono float32, and hands to Whisper.
 * @param {string} audioBase64  base64(wav-bytes)
 * @param {string=} language    'en' | 'de' | ... | undefined to auto-detect
 * @returns {Promise<string>}
 */
export async function transcribe(audioBase64, language) {
  const r = await fetch(`${VOICE_BASE}/transcribe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ audio_base64: audioBase64, language }),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || 'Transcription failed');
  return data.text || '';
}

/**
 * Text-to-speech. Returns a base64-encoded WAV and the sample rate Piper
 * emitted (typically 22050 for medium voices).
 * @param {string} text
 * @returns {Promise<{audioBase64: string, sampleRate: number}>}
 */
export async function speak(text) {
  const r = await fetch(`${VOICE_BASE}/speak`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || 'Speech synthesis failed');
  return { audioBase64: data.audio_base64, sampleRate: data.sample_rate };
}

/** Download-helper: Whisper ggml model by size. Server returns `{path, cached}`. */
export async function downloadWhisper(size = 'base') {
  const r = await fetch(`${VOICE_BASE}/download-whisper`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ size }),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || 'Whisper download failed');
  return data;
}

/** Download-helper: Piper voice model. Server returns `{path, cached}`. */
export async function downloadPiper(voice = 'en_US-amy-medium') {
  const r = await fetch(`${VOICE_BASE}/download-piper`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ voice }),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || 'Piper download failed');
  return data;
}

/**
 * Kokoro has no discrete weight-file download — the package pulls from the HF
 * cache on first use. This endpoint constructs the pipeline (which triggers
 * that fetch) + does a short throwaway synthesis to warm the per-voice cache,
 * so the user gets a clean "ready" signal in Settings instead of waiting on
 * the first real /speak call.
 */
export async function downloadKokoro(voice = 'af_heart') {
  const r = await fetch(`${VOICE_BASE}/download-kokoro`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ voice }),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || 'Kokoro warmup failed');
  return data;
}

export async function listDownloadable() {
  const r = await fetch(`${VOICE_BASE}/list-downloadable`);
  return r.json();
}

// ── Server-side recording ──────────────────────────────────────────────
// We moved the mic off the renderer (getUserMedia was crashing Chromium
// on some Windows audio drivers). These three endpoints let the server
// own the mic directly via sounddevice/PortAudio.

/** Start a recording. Resolves once PortAudio is capturing. */
export async function recordStart() {
  const r = await fetch(`${VOICE_BASE}/record/start`, { method: 'POST' });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || 'Recording start failed');
  return data;
}

/**
 * Stop the in-progress recording. By default the server transcribes inline
 * and returns `{text, duration_sec}`. Pass `{transcribe: false}` to skip
 * transcription if you just want raw recording metadata.
 * @returns {Promise<{text: string, duration_sec: number, recorded: boolean}>}
 */
export async function recordStop({ language, transcribe = true } = {}) {
  const r = await fetch(`${VOICE_BASE}/record/stop`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ language, transcribe }),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || 'Recording stop failed');
  return data;
}

/** Abort an in-flight recording without transcribing. */
export async function recordCancel() {
  try { await fetch(`${VOICE_BASE}/record/cancel`, { method: 'POST' }); }
  catch { /* best-effort */ }
}

/**
 * Ensure the voice server is running. Does an initial setup/pip-install pass on
 * first use, then spawns the Flask process. If `whisperPath` / `piperPath` /
 * `engine` / `kokoroVoice` are provided they're passed as CLI args so the
 * server boots with them preset (avoids a follow-up /config round trip).
 */
export async function ensureVoiceServer({
  pythonPath, whisperPath, piperPath, engine, kokoroVoice, onStatus,
} = {}) {
  if (!window.electronAPI) throw new Error('Not in Electron');

  const { running } = await window.electronAPI.voiceRunning();
  if (running) {
    try { await getVoiceStatus(); return; } catch { /* crashed — restart below */ }
  }

  onStatus?.('Setting up voice environment...');
  const setup = await window.electronAPI.voiceSetup({ pythonPath: pythonPath || 'python' });
  if (setup.error) throw new Error(setup.error);

  onStatus?.('Starting voice server...');
  const start = await window.electronAPI.voiceStart({
    pythonPath: pythonPath || 'python',
    whisperPath,
    piperPath,
    engine,
    kokoroVoice,
  });
  if (start.error) throw new Error(start.error);

  // Poll /status briefly — the server logs "Running on" before accepting
  // requests but there's still a tiny gap on slow machines.
  for (let i = 0; i < 10; i++) {
    try { await getVoiceStatus(); return; } catch { await new Promise(r => setTimeout(r, 500)); }
  }
  throw new Error('Voice server failed to respond');
}
