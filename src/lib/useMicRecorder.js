/**
 * useMicRecorder — Push-to-talk recorder hook.
 *
 * Records via MediaRecorder (WebM/Opus — the only format every Electron build
 * supports reliably), then decodes with an AudioContext and re-encodes as a
 * 16kHz mono WAV in-browser. The WAV is what pywhispercpp wants — if we sent
 * WebM the server would have to pull in ffmpeg or an extra decoder, so it's
 * worth the ~50 lines of conversion code to keep the server dep list small.
 *
 * Returns:
 *   isRecording   — boolean, true between start() and stop()
 *   error         — last error message (null if everything's fine)
 *   start()       — open the mic and begin capture. Idempotent.
 *   stop()        — resolves with { base64, durationSec } or null if the
 *                   recording was empty (user tapped the mic by accident).
 *   cancel()      — abort in-flight capture without resolving stop()'s promise.
 *
 * The hook owns the MediaStream lifecycle so we always release the mic —
 * Electron's indicator stays lit if we leak a track, which is confusing.
 */

import { useCallback, useRef, useState } from 'react';

const TARGET_SR = 16000; // what Whisper wants

function encodeWav(float32, sampleRate) {
  // 16-bit PCM WAV. Minimal header; no frills.
  const bytesPerSample = 2;
  const numChannels = 1;
  const pcmBytes = float32.length * bytesPerSample;
  const buf = new ArrayBuffer(44 + pcmBytes);
  const view = new DataView(buf);
  const writeStr = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + pcmBytes, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);            // PCM chunk size
  view.setUint16(20, 1, true);             // PCM format
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * numChannels * bytesPerSample, true);
  view.setUint16(32, numChannels * bytesPerSample, true);
  view.setUint16(34, bytesPerSample * 8, true);
  writeStr(36, 'data');
  view.setUint32(40, pcmBytes, true);
  // Clip + convert float → int16
  let off = 44;
  for (let i = 0; i < float32.length; i++, off += 2) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buf], { type: 'audio/wav' });
}

async function blobToBase64(blob) {
  const buf = await blob.arrayBuffer();
  // Chunked to avoid "Maximum call stack size exceeded" on big recordings.
  const bytes = new Uint8Array(buf);
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export default function useMicRecorder() {
  const [isRecording, setIsRecording] = useState(false);
  const [error, setError] = useState(null);

  const mediaRecorderRef = useRef(null);
  const streamRef = useRef(null);
  const chunksRef = useRef([]);
  const resolverRef = useRef(null);
  const cancelledRef = useRef(false);

  const releaseStream = useCallback(() => {
    if (streamRef.current) {
      try { streamRef.current.getTracks().forEach(t => t.stop()); } catch {}
      streamRef.current = null;
    }
  }, []);

  const start = useCallback(async () => {
    if (isRecording) return;
    setError(null);
    cancelledRef.current = false;
    try {
      // Disable Chromium's WebRTC audio processing (AEC/NS/AGC). Those modules
      // have a history of crashing the renderer process on Windows Electron
      // builds with certain audio drivers. We downsample + denoise downstream
      // anyway (Whisper handles it), so there's no quality reason to keep them
      // on, and we lose the crash.
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: 1,
        },
      });
      streamRef.current = stream;

      // Prefer opus; fall back to whatever the platform offers.
      const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : '';
      const mr = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
      mediaRecorderRef.current = mr;
      chunksRef.current = [];

      mr.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunksRef.current.push(e.data); };
      mr.onerror = (e) => { setError(e.error?.message || 'Recorder error'); };
      mr.onstop = async () => {
        releaseStream();
        if (cancelledRef.current) { resolverRef.current?.(null); resolverRef.current = null; return; }
        try {
          const blob = new Blob(chunksRef.current, { type: mr.mimeType || 'audio/webm' });
          if (blob.size < 2000) { resolverRef.current?.(null); resolverRef.current = null; return; }

          const ab = await blob.arrayBuffer();
          const ctx = new (window.AudioContext || window.webkitAudioContext)();
          const decoded = await ctx.decodeAudioData(ab);
          ctx.close?.();

          // Downmix to mono
          const ch = decoded.numberOfChannels;
          const frames = decoded.length;
          const mono = new Float32Array(frames);
          if (ch === 1) {
            mono.set(decoded.getChannelData(0));
          } else {
            for (let c = 0; c < ch; c++) {
              const data = decoded.getChannelData(c);
              for (let i = 0; i < frames; i++) mono[i] += data[i] / ch;
            }
          }

          // Resample to 16kHz (linear). Good enough for Whisper.
          const ratio = TARGET_SR / decoded.sampleRate;
          const newLen = Math.round(frames * ratio);
          const resampled = new Float32Array(newLen);
          for (let i = 0; i < newLen; i++) {
            const srcPos = i / ratio;
            const i0 = Math.floor(srcPos);
            const i1 = Math.min(i0 + 1, frames - 1);
            const frac = srcPos - i0;
            resampled[i] = mono[i0] * (1 - frac) + mono[i1] * frac;
          }

          const wav = encodeWav(resampled, TARGET_SR);
          const base64 = await blobToBase64(wav);
          resolverRef.current?.({ base64, durationSec: newLen / TARGET_SR });
        } catch (err) {
          setError(err.message);
          resolverRef.current?.(null);
        } finally {
          resolverRef.current = null;
        }
      };

      mr.start();
      setIsRecording(true);
    } catch (err) {
      setError(err.message || 'Microphone permission denied');
      releaseStream();
    }
  }, [isRecording, releaseStream]);

  const stop = useCallback(() => {
    if (!isRecording) return Promise.resolve(null);
    setIsRecording(false);
    return new Promise((resolve) => {
      resolverRef.current = resolve;
      try { mediaRecorderRef.current?.stop(); } catch { resolve(null); resolverRef.current = null; releaseStream(); }
    });
  }, [isRecording, releaseStream]);

  const cancel = useCallback(() => {
    cancelledRef.current = true;
    setIsRecording(false);
    try { mediaRecorderRef.current?.stop(); } catch {}
    releaseStream();
  }, [releaseStream]);

  return { isRecording, error, start, stop, cancel };
}
