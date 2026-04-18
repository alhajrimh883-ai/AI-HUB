/**
 * WelcomePage — shown on the first app launch (before `firstRunDone` is
 * set in settings.json). A 5-step wizard that walks the user through:
 *
 *   1. Intro        — greeting + what to expect
 *   2. ComfyUI      — pick launcher .bat, ComfyUI root, models path
 *   3. VLM          — VRAM management + video analysis + Auto-Optimize
 *   4. Install      — one-click install of VLM runtime, voice server,
 *                     Whisper base, and Kokoro
 *   5. Done         — tip pointing the user to Presets for model weights
 *
 * All settings picked in steps 2-3 persist immediately via the usual
 * store setters (the saveSettings debounce handles actual writes). That
 * means even if the user skips later steps, their path/VRAM choices stick.
 *
 * The `firstRunDone` flag gets flipped on either (a) a clean install,
 * (b) clicking "Skip for now", or (c) clicking "Finish" on the Done
 * screen, so returning users don't re-prompt.
 */

import React, { useEffect, useState } from 'react';
import {
  Loader2, Check, X as XIcon, Download, Package, Mic, Zap, Info,
  FolderOpen, File, ChevronRight, ChevronLeft, Cpu,
} from 'lucide-react';
import { runFirstRunInstall, getFirstRunSteps } from '../../lib/firstRunInstaller';
import { saveSettings } from '../../lib/settingsPersist';
import { getAutoOptimizeProfile, applyAutoOptimizeProfile } from '../../lib/vlmOptimize';
import useStore from '../../lib/store';
import { addLog } from '../LogsOverlay';

// Visual mapping for the install-step checklist on screen 4.
const STEP_ICONS = {
  python:  Zap,
  vlm:     Package,
  voice:   Mic,
  start:   Loader2,
  whisper: Download,
  kokoro:  Download,
};

// Five wizard screens, in order. Used for the little step indicator at top.
const SCREENS = [
  { id: 'intro',   label: 'Welcome' },
  { id: 'paths',   label: 'ComfyUI' },
  { id: 'vlm',     label: 'VLM' },
  { id: 'install', label: 'Install' },
  { id: 'done',    label: 'Done' },
];

export default function WelcomePage({ onDone }) {
  const s = useStore();
  const [screen, setScreen] = useState('intro');

  // Local state for the ComfyUI path screen. We seed these from settings
  // on mount in case the user is re-running the wizard from Settings and
  // already has paths configured.
  const [comfyRoot, setComfyRoot] = useState('');
  const [modelsPath, setModelsPath] = useState('');

  // VLM auto-detect state.
  const [sysInfo, setSysInfo] = useState(null);

  // Install-step state.
  const [steps, setSteps] = useState(() =>
    getFirstRunSteps().map(st => ({ ...st, status: 'pending', error: '' }))
  );
  const [log, setLog] = useState([]);
  const [pct, setPct] = useState(0);
  const [phase, setPhase] = useState('idle'); // 'idle' | 'running' | 'done' | 'error'
  const [installError, setInstallError] = useState('');

  // Hydrate saved ComfyUI paths + system GPU info on mount.
  useEffect(() => {
    if (!window.electronAPI) return;
    window.electronAPI.getComfyUIPath?.().then(p => setComfyRoot(p || ''));
    window.electronAPI.getModelsPath?.().then(p => setModelsPath(p || ''));
    window.electronAPI.vlmSystemInfo?.().then(setSysInfo);
  }, []);

  const markFirstRunDone = () => {
    saveSettings({ firstRunDone: true, firstRunCompletedAt: new Date().toISOString() });
  };

  // ── Navigation ───────────────────────────────────────────────
  const goNext = () => {
    const i = SCREENS.findIndex(x => x.id === screen);
    if (i < SCREENS.length - 1) setScreen(SCREENS[i + 1].id);
  };
  const goBack = () => {
    const i = SCREENS.findIndex(x => x.id === screen);
    if (i > 0) setScreen(SCREENS[i - 1].id);
  };
  const handleSkip = () => {
    // Flip the flag so we don't re-prompt. The user can re-run the wizard
    // from Settings → Setup Wizard any time.
    markFirstRunDone();
    onDone?.();
  };
  const handleFinish = () => {
    markFirstRunDone();
    onDone?.();
  };

  // ── Path pickers ─────────────────────────────────────────────
  const browseLauncher = async () => {
    if (!window.electronAPI) return;
    const p = await window.electronAPI.selectFile([
      { name: 'ComfyUI launcher', extensions: ['bat', 'sh', 'cmd', 'ps1'] },
    ]);
    if (p) s.setComfyLauncherPath(p);
  };
  const browseComfyRoot = async () => {
    if (!window.electronAPI?.selectFolder) return;
    const p = await window.electronAPI.selectFolder();
    if (p) {
      await window.electronAPI.setComfyUIPath?.(p);
      setComfyRoot(p);
    }
  };
  const browseModels = async () => {
    if (!window.electronAPI?.selectFolder) return;
    const p = await window.electronAPI.selectFolder();
    if (p) {
      await window.electronAPI.setModelsPath?.(p);
      setModelsPath(p);
    }
  };

  // ── VLM auto-optimize ────────────────────────────────────────
  const profile = getAutoOptimizeProfile(sysInfo?.gpuName);
  const handleAutoOptimize = () => {
    applyAutoOptimizeProfile(profile, {
      setVlmCtx: s.setVlmCtx,
      setVlmImageTokens: s.setVlmImageTokens,
      setVlmTargetFrames: s.setVlmTargetFrames,
      setVlmVideoMode: s.setVlmVideoMode,
      setVlmAfterInference: s.setVlmAfterInference,
    });
  };

  // ── Install ──────────────────────────────────────────────────
  const handleInstall = async () => {
    setPhase('running');
    setLog([]);
    setInstallError('');
    setSteps(prev => prev.map(st => ({ ...st, status: 'pending', error: '' })));

    const onStep = (id, status, message) => {
      setSteps(prev => prev.map(st => st.id === id ? { ...st, status, error: message || '' } : st));
    };
    const onLog = (line) => {
      setLog(prev => [...prev, line]);
      addLog('first-run', line);
    };
    const onProgress = (p) => setPct(p);

    const result = await runFirstRunInstall({ onStep, onLog, onProgress });
    if (result.ok) {
      setPhase('done');
      markFirstRunDone();
      // Auto-advance to the Done screen after a short beat so the user
      // sees the 100% bar land before we hop screens.
      setTimeout(() => setScreen('done'), 800);
    } else {
      setPhase('error');
      setInstallError(result.error || 'Install failed');
    }
  };

  // ── Render helpers ──────────────────────────────────────────
  const currentIdx = SCREENS.findIndex(x => x.id === screen);

  return (
    <div className="fixed inset-0 bg-bg-900 z-50 flex items-start justify-center p-8 overflow-y-auto">
      <div className="w-full max-w-2xl my-auto">
        {/* Step indicator — tiny dots at the top so the user can see where they are */}
        <div className="flex items-center justify-center gap-2 mb-6">
          {SCREENS.map((sc, i) => (
            <React.Fragment key={sc.id}>
              <div className={`flex items-center gap-1.5 ${i === currentIdx ? 'text-accent' : i < currentIdx ? 'text-neutral-400' : 'text-neutral-700'}`}>
                <div className={`w-1.5 h-1.5 rounded-full ${i === currentIdx ? 'bg-accent' : i < currentIdx ? 'bg-neutral-400' : 'bg-neutral-700'}`} />
                <span className="text-[9px] font-medium uppercase tracking-wider">{sc.label}</span>
              </div>
              {i < SCREENS.length - 1 && <div className={`h-px w-4 ${i < currentIdx ? 'bg-neutral-600' : 'bg-neutral-800'}`} />}
            </React.Fragment>
          ))}
        </div>

        {/* ── Screen 1: Intro ───────────────────────────────── */}
        {screen === 'intro' && (
          <>
            <div className="text-center mb-8">
              <h1 className="text-2xl font-semibold text-neutral-100 mb-2">Welcome to AI-HUB</h1>
              <p className="text-[12px] text-neutral-500 max-w-md mx-auto">
                Let's set up the local tools this app needs. Just a few quick steps —
                most of it runs automatically.
              </p>
            </div>
            <div className="bg-bg-800 border border-surface-border rounded-lg p-5 mb-6 space-y-3">
              <div className="flex items-start gap-3">
                <FolderOpen size={14} className="text-accent mt-0.5" />
                <div className="text-[11px] text-neutral-300">
                  <p className="font-medium">ComfyUI paths</p>
                  <p className="text-neutral-600">Point us at your ComfyUI launcher and model folders (optional — you can do this later).</p>
                </div>
              </div>
              <div className="flex items-start gap-3">
                <Cpu size={14} className="text-accent mt-0.5" />
                <div className="text-[11px] text-neutral-300">
                  <p className="font-medium">VLM optimization</p>
                  <p className="text-neutral-600">We'll pick VRAM + video-analysis settings that match your GPU.</p>
                </div>
              </div>
              <div className="flex items-start gap-3">
                <Download size={14} className="text-accent mt-0.5" />
                <div className="text-[11px] text-neutral-300">
                  <p className="font-medium">Install dependencies</p>
                  <p className="text-neutral-600">VLM runtime, voice server, Whisper, and Kokoro — one button, ~2 GB total.</p>
                </div>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <button onClick={goNext} className="btn btn-accent flex-1 py-2.5 text-[12px] font-semibold">
                Get Started <ChevronRight size={14} className="inline ml-1" />
              </button>
              <button onClick={handleSkip} className="btn btn-ghost text-[11px] px-4 py-2.5">
                Skip for now
              </button>
            </div>
          </>
        )}

        {/* ── Screen 2: ComfyUI paths ──────────────────────── */}
        {screen === 'paths' && (
          <>
            <div className="text-center mb-6">
              <h1 className="text-xl font-semibold text-neutral-100 mb-1.5">ComfyUI Paths</h1>
              <p className="text-[11px] text-neutral-500">
                All fields are optional — leave them blank if you're not sure and set them later in Settings.
              </p>
            </div>
            <div className="bg-bg-800 border border-surface-border rounded-lg p-5 mb-6 space-y-5">
              <PathRow
                label="ComfyUI Launch Script"
                description="e.g. run_nvidia_gpu.bat — lets the app auto-start ComfyUI when it's not running."
                value={s.comfyLauncherPath}
                onBrowse={browseLauncher}
                icon={File}
              />
              <PathRow
                label="ComfyUI Root Folder"
                description="The ComfyUI install directory (the one containing main.py). Used for scanning models."
                value={comfyRoot}
                onBrowse={browseComfyRoot}
                icon={FolderOpen}
              />
              <PathRow
                label="Models Folder"
                description="Where your checkpoints, LoRAs, and VLM GGUFs live. Usually ComfyUI/models."
                value={modelsPath}
                onBrowse={browseModels}
                icon={FolderOpen}
              />
            </div>
            <div className="flex items-center gap-3">
              <button onClick={goBack} className="btn btn-ghost text-[11px] px-4 py-2.5">
                <ChevronLeft size={14} className="inline mr-1" /> Back
              </button>
              <button onClick={goNext} className="btn btn-accent flex-1 py-2.5 text-[12px] font-semibold">
                Next <ChevronRight size={14} className="inline ml-1" />
              </button>
              <button onClick={handleSkip} className="btn btn-ghost text-[11px] px-4 py-2.5">
                Skip
              </button>
            </div>
          </>
        )}

        {/* ── Screen 3: VLM optimization ──────────────────── */}
        {screen === 'vlm' && (
          <>
            <div className="text-center mb-6">
              <h1 className="text-xl font-semibold text-neutral-100 mb-1.5">VLM Optimization</h1>
              <p className="text-[11px] text-neutral-500">
                The VLM (Vision-Language Model) analyzes images/videos to write prompts. These settings balance quality and VRAM use.
              </p>
            </div>

            {/* GPU detection + Auto-Optimize */}
            <div className="bg-bg-800 border border-surface-border rounded-lg p-5 mb-4">
              <div className="flex items-center gap-3 mb-3">
                <Cpu size={16} className="text-accent" />
                <div className="flex-1">
                  <p className="text-[11px] text-neutral-300 font-medium">Detected GPU</p>
                  <p className="text-[10px] text-neutral-500">{sysInfo?.gpuName || 'Detecting…'}</p>
                </div>
              </div>
              <div className="bg-bg-700 rounded-lg p-3 text-[10px] text-neutral-400 mb-3">
                <p className="text-[9px] uppercase tracking-wider text-neutral-500 mb-1.5">Recommended profile</p>
                <p className="text-neutral-300">{profile.label}</p>
                <p className="text-neutral-600 mt-1">
                  Context {profile.ctx.toLocaleString()} tokens · Image tokens {profile.img} ·
                  Video {profile.mode === 'multi' ? `${profile.frames} frames` : 'single frame'} ·
                  After-use: {profile.after}
                </p>
              </div>
              <button onClick={handleAutoOptimize} className="btn btn-accent text-[11px] px-3 py-1.5">
                Apply Auto-Optimize
              </button>
              {s.vlmCtx === profile.ctx && s.vlmAfterInference === profile.after && (
                <span className="text-[10px] text-green-400 ml-3">
                  <Check size={10} className="inline" /> Applied
                </span>
              )}
            </div>

            {/* VRAM management — manual override */}
            <div className="bg-bg-800 border border-surface-border rounded-lg p-5 mb-4">
              <p className="text-[10px] font-semibold text-neutral-400 uppercase tracking-wider mb-2">VRAM Management</p>
              <p className="text-[10px] text-neutral-600 mb-3">What happens to the VLM in memory after it's done analyzing an image.</p>
              <div className="flex gap-1">
                {[
                  { val: 'unload', label: 'Unload', desc: 'Frees VRAM + RAM. Slowest reload.' },
                  { val: 'park',   label: 'Park in RAM', desc: 'Frees VRAM, stays in RAM. Fast reload.' },
                  { val: 'keep',   label: 'Keep in VRAM', desc: 'Instant reuse, but competes with generation.' },
                ].map(opt => (
                  <button key={opt.val}
                    onClick={() => s.setVlmAfterInference(opt.val)}
                    className={`flex-1 text-[10px] py-1.5 rounded font-medium transition-colors ${
                      s.vlmAfterInference === opt.val ? 'bg-accent text-white' : 'btn-ghost'
                    }`}>
                    {opt.label}
                  </button>
                ))}
              </div>
              <p className="text-[9px] text-neutral-600 mt-2">
                {s.vlmAfterInference === 'unload' && 'Frees VRAM + RAM. Slowest reload.'}
                {s.vlmAfterInference === 'park' && 'Frees VRAM, stays in RAM. Fast reload.'}
                {s.vlmAfterInference === 'keep' && 'Stays in VRAM. Instant but competes with gen.'}
              </p>
            </div>

            {/* Video analysis mode */}
            <div className="bg-bg-800 border border-surface-border rounded-lg p-5 mb-4">
              <p className="text-[10px] font-semibold text-neutral-400 uppercase tracking-wider mb-2">Video Analysis</p>
              <p className="text-[10px] text-neutral-600 mb-3">How the VLM looks at videos — one frame is fast, multi-frame is more accurate.</p>
              <div className="flex gap-1 mb-3">
                <button onClick={() => s.setVlmVideoMode('single')}
                  className={`flex-1 text-[10px] py-1.5 rounded font-medium transition-colors ${s.vlmVideoMode === 'single' ? 'bg-accent text-white' : 'btn-ghost'}`}>
                  Single Frame
                </button>
                <button onClick={() => s.setVlmVideoMode('multi')}
                  className={`flex-1 text-[10px] py-1.5 rounded font-medium transition-colors ${s.vlmVideoMode === 'multi' ? 'bg-accent text-white' : 'btn-ghost'}`}>
                  Multi-Frame
                </button>
              </div>
              {s.vlmVideoMode === 'multi' && (
                <div>
                  <label className="text-[10px] text-neutral-500 block mb-1">Target Frames</label>
                  <div className="flex gap-1">
                    {[2, 4, 6, 8].map(v => (
                      <button key={v} onClick={() => s.setVlmTargetFrames(v)}
                        className={`flex-1 text-[10px] py-1.5 rounded font-medium transition-colors ${s.vlmTargetFrames === v ? 'bg-accent text-white' : 'btn-ghost'}`}>
                        {v}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <div className="bg-amber-500/5 border border-amber-500/30 rounded-lg p-3 mb-6 flex gap-2">
              <Info size={14} className="text-amber-400 mt-0.5 shrink-0" />
              <p className="text-[10px] text-neutral-400">
                You can change any of these anytime from <span className="text-accent">Settings → VLM (Local Captions)</span>.
              </p>
            </div>

            <div className="flex items-center gap-3">
              <button onClick={goBack} className="btn btn-ghost text-[11px] px-4 py-2.5">
                <ChevronLeft size={14} className="inline mr-1" /> Back
              </button>
              <button onClick={goNext} className="btn btn-accent flex-1 py-2.5 text-[12px] font-semibold">
                Next <ChevronRight size={14} className="inline ml-1" />
              </button>
              <button onClick={handleSkip} className="btn btn-ghost text-[11px] px-4 py-2.5">
                Skip
              </button>
            </div>
          </>
        )}

        {/* ── Screen 4: Install ───────────────────────────── */}
        {screen === 'install' && (
          <>
            <div className="text-center mb-6">
              <h1 className="text-xl font-semibold text-neutral-100 mb-1.5">Install Dependencies</h1>
              <p className="text-[11px] text-neutral-500">
                One click installs the VLM runtime, voice server, Whisper, and Kokoro. About 2 GB, 5-15 min on a fresh machine.
              </p>
            </div>
            <div className="bg-bg-800 border border-surface-border rounded-lg p-4 mb-4">
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-[12px] font-semibold text-neutral-300">What we'll install</h2>
                <span className="text-[10px] text-neutral-600">~2 GB total</span>
              </div>
              <ul className="space-y-2">
                {steps.map(st => {
                  const Icon = st.status === 'running' ? Loader2
                             : st.status === 'done'    ? Check
                             : st.status === 'error'   ? XIcon
                             : (STEP_ICONS[st.id] || Package);
                  const iconClass =
                    st.status === 'running' ? 'text-accent animate-spin' :
                    st.status === 'done'    ? 'text-green-400' :
                    st.status === 'error'   ? 'text-red-400'   :
                                              'text-neutral-600';
                  return (
                    <li key={st.id} className="flex items-start gap-3">
                      <Icon size={14} className={`mt-0.5 shrink-0 ${iconClass}`} />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-[11px] text-neutral-300">{st.label}</span>
                          {st.sizeText && <span className="text-[9px] text-neutral-600">{st.sizeText}</span>}
                        </div>
                        {st.error && <p className="text-[10px] text-red-400 mt-0.5 break-words">{st.error}</p>}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
            {(phase === 'running' || phase === 'done' || phase === 'error') && (
              <div className="bg-bg-800 border border-surface-border rounded-lg p-4 mb-4">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-[10px] text-neutral-500">Progress</span>
                  <span className="text-[10px] text-neutral-400 tabular-nums">{pct}%</span>
                </div>
                <div className="h-1.5 bg-bg-700 rounded-full overflow-hidden mb-3">
                  <div className="h-full bg-accent transition-all" style={{ width: `${pct}%` }} />
                </div>
                <pre className="text-[9px] text-neutral-500 bg-bg-900 border border-surface-border rounded p-2 max-h-48 overflow-y-auto whitespace-pre-wrap font-mono">
                  {log.length ? log.join('\n') : 'Starting…'}
                </pre>
              </div>
            )}
            <div className="flex items-center gap-3">
              {phase === 'idle' && (
                <>
                  <button onClick={goBack} className="btn btn-ghost text-[11px] px-4 py-2.5">
                    <ChevronLeft size={14} className="inline mr-1" /> Back
                  </button>
                  <button onClick={handleInstall} className="btn btn-accent flex-1 py-2.5 text-[12px] font-semibold">
                    Install Everything
                  </button>
                  <button onClick={handleSkip} className="btn btn-ghost text-[11px] px-4 py-2.5">
                    Skip
                  </button>
                </>
              )}
              {phase === 'running' && (
                <button disabled className="btn btn-accent flex-1 py-2.5 text-[12px] font-semibold opacity-60 cursor-wait">
                  <Loader2 size={14} className="inline animate-spin mr-2" />
                  Installing… please keep the app open
                </button>
              )}
              {phase === 'error' && (
                <>
                  <button onClick={handleInstall} className="btn btn-accent flex-1 py-2.5 text-[12px] font-semibold">
                    Retry
                  </button>
                  <button onClick={handleSkip} className="btn btn-ghost text-[11px] px-4 py-2.5">
                    Skip
                  </button>
                </>
              )}
            </div>
            {phase === 'error' && installError && (
              <p className="text-[10px] text-red-400 mt-3 text-center">{installError}</p>
            )}
          </>
        )}

        {/* ── Screen 5: Done ──────────────────────────────── */}
        {screen === 'done' && (
          <>
            <div className="text-center mb-6">
              <div className="w-12 h-12 mx-auto mb-3 rounded-full bg-green-500/10 border border-green-500/30 flex items-center justify-center">
                <Check size={20} className="text-green-400" />
              </div>
              <h1 className="text-xl font-semibold text-neutral-100 mb-1.5">You're all set</h1>
              <p className="text-[11px] text-neutral-500">AI-HUB is ready to go.</p>
            </div>
            <div className="bg-amber-500/5 border border-amber-500/30 rounded-lg p-4 mb-4 flex gap-3">
              <Info size={14} className="text-amber-400 mt-0.5 shrink-0" />
              <div className="text-[11px] text-neutral-300">
                <p className="font-medium text-amber-300 mb-1">One more thing: pick a VLM model</p>
                <p className="text-neutral-400">
                  We installed the VLM runtime (llama-cpp-python) but no model weights.
                  Open the <span className="text-accent">Presets</span> tab to point it at a
                  GGUF on disk — Qwen2-VL-7B-Instruct is a solid default.
                </p>
              </div>
            </div>
            <p className="text-[10px] text-neutral-600 text-center mb-6">
              Any of these settings can be changed later in the Settings tab.
            </p>
            <button onClick={handleFinish} className="btn btn-accent w-full py-2.5 text-[12px] font-semibold">
              Continue to the app →
            </button>
          </>
        )}

        <p className="text-[9px] text-neutral-700 text-center mt-6">
          You can re-run this wizard from Settings → Setup Wizard.
        </p>
      </div>
    </div>
  );
}

// Small row component for the path-picker screen. Factored out so we
// don't repeat label/description/input/browse boilerplate three times.
function PathRow({ label, description, value, onBrowse, icon: Icon = File }) {
  return (
    <div>
      <div className="flex items-center gap-2 mb-1">
        <Icon size={12} className="text-neutral-500" />
        <label className="text-[11px] text-neutral-300 font-medium">{label}</label>
      </div>
      <div className="flex items-center gap-1.5">
        <input
          type="text"
          value={value}
          readOnly
          placeholder="Not set"
          title={value}
          className="input-field flex-1 text-[10px] truncate"
        />
        <button onClick={onBrowse} className="btn btn-ghost px-2 py-1.5 text-[10px]">
          Browse
        </button>
      </div>
      {description && <p className="text-[9px] text-neutral-600 mt-1">{description}</p>}
    </div>
  );
}
