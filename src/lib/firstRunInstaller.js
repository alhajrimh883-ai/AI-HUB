/**
 * First-Run Installer — orchestrates all of the first-launch installs in
 * one sequential flow so the user only has to click a single "Install
 * Everything" button instead of hunting them down in Settings.
 *
 * Steps (in order):
 *   1. Detect Python (needs to be on PATH or pre-configured)
 *   2. VLM: install llama-cpp-python wheel (no model download — user picks
 *      a model later in the Presets tab)
 *   3. Voice: create venv + pip install pywhispercpp, piper-tts, kokoro,
 *      soundfile (this is the heavy step, ~1.5 GB with torch)
 *   4. Voice: start the Flask subprocess
 *   5. Download the default Whisper model (base, ~150 MB)
 *   6. Warm Kokoro (pulls weights from HuggingFace + runs a throwaway
 *      synthesis so the first real /speak call doesn't hang)
 *
 * Each step takes a `onProgress(message, pct)` callback so the UI can
 * stream status updates into a log. Returns `{ ok, completed, error }`
 * — `completed` is the list of steps that succeeded before any failure,
 * so the UI can tell the user how far we got.
 */

import * as voice from './voiceClient';

const STEPS = [
  { id: 'python',  label: 'Detect Python',                    weight: 1,  sizeText: '' },
  { id: 'vlm',     label: 'Install VLM (llama-cpp-python)',   weight: 10, sizeText: '~50 MB' },
  { id: 'voice',   label: 'Install voice packages',           weight: 40, sizeText: '~1.5 GB' },
  { id: 'start',   label: 'Start voice server',               weight: 2,  sizeText: '' },
  { id: 'whisper', label: 'Download Whisper base model',      weight: 5,  sizeText: '~150 MB' },
  { id: 'kokoro',  label: 'Warm Kokoro TTS',                  weight: 15, sizeText: '~330 MB' },
];

export function getFirstRunSteps() {
  return STEPS.map(s => ({ ...s }));
}

function totalWeight() { return STEPS.reduce((a, s) => a + s.weight, 0); }

/**
 * Run the full first-run install pipeline.
 *
 * @param {{
 *   pythonPath?: string,
 *   onStep?: (stepId: string, status: 'running'|'done'|'error', message?: string) => void,
 *   onLog?: (line: string) => void,
 *   onProgress?: (pct: number) => void,
 * }} opts
 */
export async function runFirstRunInstall({ pythonPath, onStep, onLog, onProgress } = {}) {
  if (!window.electronAPI) {
    return { ok: false, completed: [], error: 'Not running in Electron — first-run install is only available in the desktop app.' };
  }

  const completed = [];
  const total = totalWeight();
  let cumulative = 0;
  const bump = (weight) => {
    cumulative += weight;
    onProgress?.(Math.min(100, Math.round((cumulative / total) * 100)));
  };

  const step = async (id, fn) => {
    const s = STEPS.find(x => x.id === id);
    onStep?.(id, 'running');
    onLog?.(`→ ${s.label}${s.sizeText ? ` (${s.sizeText})` : ''}…`);
    try {
      const res = await fn();
      completed.push(id);
      onStep?.(id, 'done');
      onLog?.(`  ✓ ${s.label} done`);
      bump(s.weight);
      return res;
    } catch (e) {
      onStep?.(id, 'error', e.message);
      onLog?.(`  ✗ ${s.label} failed: ${e.message}`);
      throw e;
    }
  };

  try {
    // 1. Detect Python — resolve the path we'll use for the rest of the run.
    const py = await step('python', async () => {
      const detected = await window.electronAPI.detectPython?.();
      const path = pythonPath || detected?.path || 'python';
      onLog?.(`  using Python: ${path}`);
      return path;
    });

    // 2. VLM — installs llama-cpp-python wheel. No model download; user
    //    sets their own in the Presets tab.
    await step('vlm', async () => {
      const r = await window.electronAPI.vlmSetup({ pythonPath: py });
      if (r?.error) throw new Error(r.error);
    });

    // 3. Voice — venv + big pip install (torch, kokoro, pywhispercpp, piper,
    //    soundfile). This is the slowest step — can take 5-10 min on a fresh
    //    machine.
    await step('voice', async () => {
      const r = await window.electronAPI.voiceSetup({ pythonPath: py });
      if (r?.error) throw new Error(r.error);
    });

    // 4. Start the voice server so downloads have somewhere to land.
    await step('start', async () => {
      const r = await window.electronAPI.voiceStart({ pythonPath: py });
      if (r?.error) throw new Error(r.error);
      // Poll /status briefly — server may log "Running on" before accepting
      // requests.
      for (let i = 0; i < 15; i++) {
        try { await voice.getVoiceStatus(); return; }
        catch { await new Promise(r => setTimeout(r, 500)); }
      }
      throw new Error('Voice server failed to respond after 7.5 s');
    });

    // 5. Whisper — download the base model (150 MB). User can upgrade to
    //    small/medium in Settings later.
    await step('whisper', async () => {
      const r = await voice.downloadWhisper('base');
      onLog?.(`  whisper model at ${r?.path || 'cache'}${r?.cached ? ' (cached)' : ''}`);
    });

    // 6. Kokoro — pulls weights via HF cache + warms the pipeline for
    //    af_heart. First /speak call would otherwise hang ~30 s.
    await step('kokoro', async () => {
      const r = await voice.downloadKokoro('af_heart');
      onLog?.(`  kokoro ready${r?.cached ? ' (cached)' : ''}`);
    });

    onLog?.('All installs complete. You can start using the app.');
    return { ok: true, completed };
  } catch (e) {
    return { ok: false, completed, error: e.message };
  }
}
