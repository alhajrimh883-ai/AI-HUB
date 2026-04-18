import React, { useState, useEffect } from 'react';
import useStore from '../../lib/store';
import useStudioSettings from '../../lib/studioStore';
import useVoiceStore from '../../lib/voiceStore';
import * as voice from '../../lib/voiceClient';
import { getAutoOptimizeProfile, applyAutoOptimizeProfile } from '../../lib/vlmOptimize';
import { File, Settings, Mic, Volume2 } from 'lucide-react';

function FileBrowser({ label, value, onChange, extensions, description }) {
  const browse = async () => {
    if (!window.electronAPI) return;
    const p = await window.electronAPI.selectFile(extensions ? [{ name: 'Models', extensions }] : undefined);
    if (p) onChange(p);
  };
  return (
    <div className="mb-3">
      <label className="text-[11px] text-neutral-400 block mb-1">{label}</label>
      <div className="flex items-center gap-1.5">
        <input type="text" value={value} readOnly placeholder="Browse..." className="input-field flex-1 text-[10px] truncate" title={value} />
        <button onClick={browse} className="btn btn-ghost p-1.5 shrink-0"><File size={13} /></button>
      </div>
      {description && <p className="text-[9px] text-neutral-600 mt-0.5">{description}</p>}
    </div>
  );
}


export default function AppSettingsPage() {
  const s = useStore();
  const studioCfg = useStudioSettings();
  const vc = useVoiceStore();
  const [sysInfo, setSysInfo] = useState(null);
  const [ramInfo, setRamInfo] = useState(null);
  const [setupStatus, setSetupStatus] = useState('');
  const [modelsPath, setModelsPathLocal] = useState('');
  const [comfyRoot, setComfyRootLocal] = useState('');
  // Output directory is a derived, non-user-configurable path (getAppDir()/output).
  // We still surface it read-only in Settings so the user can see where files land.
  const [outputDirLocal, setOutputDirLocal] = useState('');
  const [modelSubfolders, setModelSubfolders] = useState([]);
  const [voiceStatus, setVoiceStatus] = useState('');
  const [voiceBusy, setVoiceBusy] = useState(false);
  const [voiceServerState, setVoiceServerState] = useState(null);

  // Load system info + paths on mount
  useEffect(() => {
    if (window.electronAPI?.vlmSystemInfo) window.electronAPI.vlmSystemInfo().then(setSysInfo);
    if (window.electronAPI?.vlmRamCheck) window.electronAPI.vlmRamCheck().then(setRamInfo);
    if (window.electronAPI?.getComfyUIPath) window.electronAPI.getComfyUIPath().then(p => setComfyRootLocal(p || ''));
    if (window.electronAPI?.getOutputDir) window.electronAPI.getOutputDir().then(p => setOutputDirLocal(p || ''));
    if (window.electronAPI?.getModelsPath) window.electronAPI.getModelsPath().then(async (p) => {
      setModelsPathLocal(p || '');
      if (p && window.electronAPI.listSubfolders) {
        const subs = await window.electronAPI.listSubfolders(p);
        setModelSubfolders(subs || []);
      }
    });
  }, [setupStatus]);

  const updateModelsPath = async (p) => {
    if (!window.electronAPI || !p) return;
    await window.electronAPI.setModelsPath(p);
    setModelsPathLocal(p);
    const subs = await window.electronAPI.listSubfolders(p);
    setModelSubfolders(subs || []);
    await rescanModels();
  };

  const rescanModels = async () => {
    if (!window.electronAPI) return;
    try {
      const upscale = await window.electronAPI.scanUpscaleModels();
      console.log('[Settings] Upscale models scan:', upscale);
      s.setComfyUpscaleModels((upscale || []).map(m => m.path || m.name));
    } catch (e) { console.error('[Settings] Upscale scan failed:', e); }
    try {
      const latent = await window.electronAPI.scanLatentUpscaleModels();
      console.log('[Settings] Latent upscale scan:', latent);
      s.setComfyLatentUpscaleModels((latent || []).map(m => m.path || m.name));
    } catch (e) { console.error('[Settings] Latent scan failed:', e); }
    // Also scan a custom path to list subfolders for debug
    try {
      const mp = await window.electronAPI.getModelsPath();
      if (mp) {
        const all = await window.electronAPI.scanModelsFolder(mp);
        console.log('[Settings] All files in models root:', all?.length, 'files');
      }
    } catch {}
  };

  const handleVlmSetup = async () => {
    setSetupStatus('Setting up...');
    const result = await window.electronAPI.vlmSetup({ pythonPath: s.pythonPath || 'python' });
    setSetupStatus(result.error || 'Setup complete!');
    if (!result.error) setTimeout(() => setSetupStatus(''), 3000);
  };

  // ── Voice helpers ──
  // Each handler keeps voiceBusy true for the duration so the UI can disable
  // buttons and the user knows something is happening (pip installs can take
  // a minute; model downloads can take several).
  const refreshVoiceServerState = async () => {
    try { setVoiceServerState(await voice.getVoiceStatus()); }
    catch { setVoiceServerState(null); }
  };
  const handleVoiceInstall = async () => {
    setVoiceBusy(true);
    setVoiceStatus('Setting up voice environment (venv + pywhispercpp + piper-tts + kokoro)…');
    try {
      await voice.ensureVoiceServer({
        pythonPath: s.pythonPath || 'python',
        whisperPath: vc.whisperPath || undefined,
        piperPath: vc.piperPath || undefined,
        engine: vc.engine,
        kokoroVoice: vc.kokoroVoice,
        onStatus: (msg) => setVoiceStatus(msg),
      });
      setVoiceStatus('Voice server running.');
      await refreshVoiceServerState();
    } catch (e) { setVoiceStatus(`Failed: ${e.message}`); }
    setVoiceBusy(false);
  };
  const handleDownloadKokoro = async () => {
    setVoiceBusy(true);
    setVoiceStatus(`Warming Kokoro (${vc.kokoroVoice})… first run pulls weights from HuggingFace.`);
    try {
      await voice.ensureVoiceServer({
        pythonPath: s.pythonPath || 'python',
        engine: 'kokoro',
        kokoroVoice: vc.kokoroVoice,
        onStatus: setVoiceStatus,
      });
      await voice.setVoiceConfig({ engine: 'kokoro', kokoro_voice: vc.kokoroVoice });
      const r = await voice.downloadKokoro(vc.kokoroVoice);
      setVoiceStatus(r.cached ? `Kokoro already loaded (${vc.kokoroVoice}).` : `Kokoro ready (${vc.kokoroVoice}).`);
      await refreshVoiceServerState();
    } catch (e) { setVoiceStatus(`Failed: ${e.message}`); }
    setVoiceBusy(false);
  };
  const handleDownloadWhisper = async () => {
    setVoiceBusy(true);
    setVoiceStatus(`Downloading Whisper (${vc.whisperSize})…`);
    try {
      await voice.ensureVoiceServer({ pythonPath: s.pythonPath || 'python', onStatus: setVoiceStatus });
      const r = await voice.downloadWhisper(vc.whisperSize);
      vc.setWhisperPath(r.path);
      await voice.setVoiceConfig({ whisper_path: r.path });
      setVoiceStatus(r.cached ? `Whisper already downloaded (${vc.whisperSize}).` : `Whisper downloaded → ${r.path}`);
      await refreshVoiceServerState();
    } catch (e) { setVoiceStatus(`Failed: ${e.message}`); }
    setVoiceBusy(false);
  };
  const handleDownloadPiper = async () => {
    setVoiceBusy(true);
    setVoiceStatus(`Downloading Piper (${vc.piperVoice})…`);
    try {
      await voice.ensureVoiceServer({ pythonPath: s.pythonPath || 'python', onStatus: setVoiceStatus });
      const r = await voice.downloadPiper(vc.piperVoice);
      vc.setPiperPath(r.path);
      await voice.setVoiceConfig({ piper_path: r.path });
      setVoiceStatus(r.cached ? `Piper already downloaded (${vc.piperVoice}).` : `Piper downloaded → ${r.path}`);
      await refreshVoiceServerState();
    } catch (e) { setVoiceStatus(`Failed: ${e.message}`); }
    setVoiceBusy(false);
  };
  const handleTestTts = async () => {
    setVoiceBusy(true);
    setVoiceStatus(`Synthesizing speech via ${vc.engine}…`);
    try {
      await voice.ensureVoiceServer({
        pythonPath: s.pythonPath || 'python',
        engine: vc.engine,
        kokoroVoice: vc.kokoroVoice,
        onStatus: setVoiceStatus,
      });
      // Always push current engine state to the server before testing, so the
      // result reflects the Settings dropdown even if the server started earlier.
      const cfg = { engine: vc.engine };
      if (vc.engine === 'piper' && vc.piperPath) cfg.piper_path = vc.piperPath;
      if (vc.engine === 'kokoro') cfg.kokoro_voice = vc.kokoroVoice;
      await voice.setVoiceConfig(cfg);
      const { audioBase64 } = await voice.speak('Hello! Voice chat is working.');
      const audio = new Audio('data:audio/wav;base64,' + audioBase64);
      audio.onended = () => setVoiceStatus('TTS test done.');
      await audio.play();
      setVoiceStatus('Playing…');
    } catch (e) { setVoiceStatus(`Failed: ${e.message}`); }
    setVoiceBusy(false);
  };
  const browseWhisper = async () => {
    if (!window.electronAPI) return;
    const p = await window.electronAPI.selectFile([{ name: 'Whisper ggml', extensions: ['bin'] }]);
    if (p) { vc.setWhisperPath(p); try { await voice.setVoiceConfig({ whisper_path: p }); } catch {} }
  };
  const browsePiper = async () => {
    if (!window.electronAPI) return;
    const p = await window.electronAPI.selectFile([{ name: 'Piper voice', extensions: ['onnx'] }]);
    if (p) { vc.setPiperPath(p); try { await voice.setVoiceConfig({ piper_path: p }); } catch {} }
  };



  const handleRerunFirstRun = async () => {
    if (!window.electronAPI) return;
    // Flip the flag back off so the welcome wizard takes over next reload.
    const cur = (await window.electronAPI.loadSettings()) || {};
    delete cur.firstRunDone;
    delete cur.firstRunCompletedAt;
    await window.electronAPI.saveSettings(cur);
    // Reload to get a clean start.
    window.location.reload();
  };

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-2xl mx-auto p-6 space-y-6">
        <div className="flex items-center gap-2 mb-2">
          <Settings size={18} className="text-accent" />
          <h1 className="text-sm font-bold text-neutral-200">App Settings</h1>
        </div>

        {/* ── First-Run Installer (re-run) ── */}
        <div className="panel p-4">
          <div className="panel-title mb-2">Setup Wizard</div>
          <p className="text-[10px] text-neutral-600 mb-3">
            Run the full installer again — useful if you skipped it on first launch or
            want to reinstall everything from scratch.
          </p>
          <button onClick={handleRerunFirstRun} className="btn btn-ghost text-[10px] px-3 py-1.5">
            Re-run Setup Wizard
          </button>
        </div>

        {/* ── ComfyUI ── */}
        <div className="panel p-4">
          <div className="panel-title mb-3">ComfyUI</div>
          <p className="text-[10px] text-neutral-600 mb-3">Set your ComfyUI launcher so the app can auto-start it when needed.</p>
          <div className="mb-3">
            <FileBrowser label="ComfyUI Launch Script" value={s.comfyLauncherPath} onChange={s.setComfyLauncherPath}
              extensions={['bat', 'sh', 'cmd', 'ps1']} description="e.g. run_nvidia_gpu.bat" />
          </div>
          <div className="mb-3">
            <FileBrowser label="ComfyUI Folder" value={comfyRoot} onChange={async (p) => {
              // Persist via the Electron main-process handler (writes to settings.json),
              // then reflect the new value in local state so the field updates immediately.
              if (window.electronAPI?.setComfyUIPath) await window.electronAPI.setComfyUIPath(p);
              setComfyRootLocal(p);
            }} description="Root folder containing main.py" />
          </div>
          <div className="mb-3">
            {/* Output directory is computed (appDir/output) — show it read-only. */}
            <label className="text-[11px] text-neutral-400 block mb-1">Output Directory</label>
            <input type="text" value={outputDirLocal} readOnly className="input-field w-full text-[10px] truncate" title={outputDirLocal} />
            <p className="text-[9px] text-neutral-600 mt-0.5">Where generated images/projects are saved (auto-managed)</p>
            {outputDirLocal && (
              <div className="mt-1.5 text-[9px] space-y-1">
                <p className="text-neutral-500">Sessions and packages are stored in: <span className="text-neutral-300 font-mono">{outputDirLocal}/sessions/</span></p>
                <p className="text-neutral-500">Director projects: <span className="text-neutral-300 font-mono">{outputDirLocal}/director_projects/</span></p>
              </div>
            )}
          </div>
          <div className="flex items-center gap-2">
            <div className={`w-2 h-2 rounded-full ${s.connected ? 'bg-green-400' : 'bg-red-500'}`} />
            <span className="text-[11px] text-neutral-400">{s.connected ? 'Connected to http://127.0.0.1:8188' : 'Not connected'}</span>
            <div className="flex-1" />
            {!s.connected && s.comfyLauncherPath && (
              <button onClick={async () => {
                if (!window.electronAPI) return;
                s.setComfyLaunchStatus('Starting...');
                const result = await window.electronAPI.comfyLaunch({ launcherPath: s.comfyLauncherPath });
                s.setComfyLaunchStatus(result.ok ? 'Launched!' : `Failed: ${result.error}`);
                setTimeout(() => s.setComfyLaunchStatus(''), 5000);
              }} className="btn btn-accent text-[10px] px-3 py-1">
                Launch
              </button>
            )}
            {s.comfyLaunchStatus && <span className="text-[10px] text-amber-400">{s.comfyLaunchStatus}</span>}
          </div>
          <div className="mt-3 pt-3 border-t border-surface-border">
            <label className="text-[11px] text-neutral-400 block mb-1.5">When App Closes (ComfyUI)</label>
            <div className="flex gap-1">
              {[
                { val: 'ask', label: 'Ask Me' },
                { val: 'close', label: 'Always Close' },
                { val: 'keep', label: 'Keep Running' },
              ].map(opt => (
                <button key={opt.val} onClick={() => s.setComfyCloseAction(opt.val)}
                  className={`flex-1 text-[10px] py-1.5 rounded font-medium transition-colors ${s.comfyCloseAction === opt.val ? 'bg-accent text-white' : 'btn-ghost'}`}>
                  {opt.label}
                </button>
              ))}
            </div>
            <p className="text-[9px] text-neutral-600 mt-1">
              {s.comfyCloseAction === 'ask' && 'A popup will ask whether to close ComfyUI when you exit the app.'}
              {s.comfyCloseAction === 'close' && 'ComfyUI will automatically close when you exit the app.'}
              {s.comfyCloseAction === 'keep' && 'ComfyUI will keep running after you close the app.'}
            </p>
          </div>
        </div>

        {/* ── Notifications ── */}
        <div className="panel p-4">
          <div className="panel-title mb-3">Notifications</div>
          <div className="flex items-center justify-between mb-3">
            <div>
              <span className="text-[11px] text-neutral-300">Toast Notifications</span>
              <p className="text-[9px] text-neutral-600 mt-0.5">Show popup notifications when generations complete or fail.</p>
            </div>
            <button onClick={() => s.setShowToasts(!s.showToasts)}
              className={`w-9 h-5 rounded-full relative transition-colors shrink-0 ${s.showToasts ? 'bg-emerald-500' : 'bg-neutral-800 border border-neutral-700'}`}>
              <div className={`w-3.5 h-3.5 bg-white rounded-full absolute top-[3px] transition-all shadow-sm ${s.showToasts ? 'left-[18px]' : 'left-[3px]'}`} />
            </button>
          </div>
          <div className="flex items-center justify-between">
            <div>
              <span className="text-[11px] text-neutral-300">Skip delete confirmation</span>
              <p className="text-[9px] text-neutral-600 mt-0.5">Delete images instantly without "are you sure?" popup.</p>
            </div>
            <button onClick={() => studioCfg.setSkipDeleteConfirm?.(!studioCfg.skipDeleteConfirm)}
              className={`w-9 h-5 rounded-full relative transition-colors shrink-0 ${studioCfg.skipDeleteConfirm ? 'bg-emerald-500' : 'bg-neutral-800 border border-neutral-700'}`}>
              <div className={`w-3.5 h-3.5 bg-white rounded-full absolute top-[3px] transition-all shadow-sm ${studioCfg.skipDeleteConfirm ? 'left-[18px]' : 'left-[3px]'}`} />
            </button>
          </div>
        </div>

        {/* ── VLM ── */}
        <div className="panel p-4">
          <div className="panel-title mb-3">VLM Configuration</div>
          {sysInfo && (
            <div className="bg-bg-700 rounded-md p-2.5 text-[10px] space-y-0.5 mb-3">
              <p className="text-neutral-400 font-semibold mb-1">Detected System</p>
              <div className="grid grid-cols-2 gap-x-4 gap-y-0.5">
                <p className="text-neutral-300">GPU: {sysInfo.gpuName || 'Not detected'}</p>
                <p className="text-neutral-300">CUDA: {sysInfo.cudaVersion || 'N/A'} {sysInfo.cudaTag ? `(${sysInfo.cudaTag})` : ''}</p>
                <p className={sysInfo.venvReady ? 'text-green-400' : 'text-neutral-500'}>Venv: {sysInfo.venvReady ? '✓ Ready' : '○ Not set up'}</p>
                <p className={sysInfo.llamaInstalled ? 'text-green-400' : 'text-neutral-500'}>llama-cpp: {sysInfo.llamaInstalled ? '✓ Installed' : '○ Not installed'}</p>
              </div>
            </div>
          )}
          <div className="mb-3 flex items-center gap-2 flex-wrap">
            <button onClick={handleVlmSetup} disabled={setupStatus === 'Setting up...'} className="btn btn-accent text-[10px] px-3 py-1.5 disabled:opacity-40">
              {setupStatus === 'Setting up...' ? 'Setting up...' : sysInfo?.llamaInstalled ? 'Reinstall' : 'Install VLM'}
            </button>
            <button onClick={() => {
              // Shared profile table lives in src/lib/vlmOptimize.js so the
              // Settings page and the first-run wizard always agree.
              const profile = getAutoOptimizeProfile(sysInfo?.gpuName);
              applyAutoOptimizeProfile(profile, {
                setVlmCtx: s.setVlmCtx,
                setVlmImageTokens: s.setVlmImageTokens,
                setVlmTargetFrames: s.setVlmTargetFrames,
                setVlmVideoMode: s.setVlmVideoMode,
                setVlmAfterInference: s.setVlmAfterInference,
              });
            }} className="btn btn-ghost text-[10px] px-3 py-1.5 border border-accent/30 text-accent">
              Auto-Optimize
            </button>
            {setupStatus && <span className={`text-[10px] ${setupStatus.includes('fail') || setupStatus.includes('error') ? 'text-red-400' : 'text-green-400'}`}>{setupStatus}</span>}
          </div>
          <p className="text-[9px] text-neutral-500 mb-3">VLM model, context, and image tokens are configured per-preset in <span className="text-accent">Presets → VLM</span>.</p>
          <div className="bg-bg-700 rounded-lg p-3 mb-3 space-y-3">
            <p className="text-[10px] font-semibold text-neutral-400 uppercase tracking-wider">VRAM Management</p>
            <div>
              <label className="text-[10px] text-neutral-500 block mb-1">After Inference</label>
              <div className="flex gap-1">
                {[{ val: 'unload', label: 'Unload' }, { val: 'park', label: 'Park in RAM' }, { val: 'keep', label: 'Keep in VRAM' }].map(opt => (
                  <button key={opt.val} onClick={() => s.setVlmAfterInference(opt.val)}
                    className={`flex-1 text-[10px] py-1.5 rounded font-medium transition-colors ${s.vlmAfterInference === opt.val ? 'bg-accent text-white' : 'btn-ghost'}`}>
                    {opt.label}
                  </button>
                ))}
              </div>
              <p className="text-[9px] text-neutral-600 mt-1">
                {s.vlmAfterInference === 'unload' && 'Frees VRAM + RAM. Slowest reload.'}
                {s.vlmAfterInference === 'park' && 'Frees VRAM, stays in RAM. Fast reload.'}
                {s.vlmAfterInference === 'keep' && 'Stays in VRAM. Instant but competes with gen.'}
              </p>
            </div>
          </div>
          <div className="bg-bg-700 rounded-lg p-3 space-y-3">
            <p className="text-[10px] font-semibold text-neutral-400 uppercase tracking-wider">Video Analysis</p>
            <div>
              <label className="text-[10px] text-neutral-500 block mb-1">Analysis Mode</label>
              <div className="flex gap-1">
                <button onClick={() => s.setVlmVideoMode('single')} className={`flex-1 text-[10px] py-1.5 rounded font-medium transition-colors ${s.vlmVideoMode === 'single' ? 'bg-accent text-white' : 'btn-ghost'}`}>Single Frame</button>
                <button onClick={() => s.setVlmVideoMode('multi')} className={`flex-1 text-[10px] py-1.5 rounded font-medium transition-colors ${s.vlmVideoMode === 'multi' ? 'bg-accent text-white' : 'btn-ghost'}`}>Multi-Frame</button>
              </div>
            </div>
            {s.vlmVideoMode === 'multi' && (
              <div>
                <label className="text-[10px] text-neutral-500 block mb-1">Target Frames</label>
                <div className="flex gap-1">
                  {[2, 4, 6, 8].map(v => (
                    <button key={v} onClick={() => s.setVlmTargetFrames(v)} className={`flex-1 text-[10px] py-1.5 rounded font-medium transition-colors ${s.vlmTargetFrames === v ? 'bg-accent text-white' : 'btn-ghost'}`}>{v}</button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* ── Voice Chat ── */}
        <div className="panel p-4">
          <div className="panel-title mb-3 flex items-center gap-2"><Mic size={13} className="text-accent" /> Voice Chat</div>
          <p className="text-[10px] text-neutral-600 mb-3">
            Local speech-to-text (Whisper) + text-to-speech (Kokoro, with Piper as a fallback). Runs in its own Python process — separate from the VLM server so the installs don't clash.
          </p>

          {/* Master toggles */}
          <div className="flex items-center justify-between mb-2">
            <div>
              <span className="text-[11px] text-neutral-300">Enable voice chat</span>
              <p className="text-[9px] text-neutral-600 mt-0.5">Shows a mic button in the Chat input bar.</p>
            </div>
            <button onClick={() => vc.setEnabled(!vc.enabled)}
              className={`w-9 h-5 rounded-full relative transition-colors shrink-0 ${vc.enabled ? 'bg-emerald-500' : 'bg-neutral-800 border border-neutral-700'}`}>
              <div className={`w-3.5 h-3.5 bg-white rounded-full absolute top-[3px] transition-all shadow-sm ${vc.enabled ? 'left-[18px]' : 'left-[3px]'}`} />
            </button>
          </div>
          <div className="flex items-center justify-between mb-3">
            <div>
              <span className="text-[11px] text-neutral-300">Auto-speak replies</span>
              <p className="text-[9px] text-neutral-600 mt-0.5">Play the assistant's reply aloud as soon as it finishes.</p>
            </div>
            <button onClick={() => vc.setAutoSpeak(!vc.autoSpeak)}
              className={`w-9 h-5 rounded-full relative transition-colors shrink-0 ${vc.autoSpeak ? 'bg-emerald-500' : 'bg-neutral-800 border border-neutral-700'}`}>
              <div className={`w-3.5 h-3.5 bg-white rounded-full absolute top-[3px] transition-all shadow-sm ${vc.autoSpeak ? 'left-[18px]' : 'left-[3px]'}`} />
            </button>
          </div>

          {/* Install button */}
          <div className="mb-3 flex items-center gap-2 flex-wrap">
            <button onClick={handleVoiceInstall} disabled={voiceBusy}
              className="btn btn-accent text-[10px] px-3 py-1.5 disabled:opacity-40">
              {voiceBusy ? 'Working…' : 'Install / Start Voice Server'}
            </button>
            <button onClick={refreshVoiceServerState} className="btn btn-ghost text-[10px] px-2 py-1.5">Refresh</button>
            {voiceServerState && (
              <span className="text-[9px] text-neutral-500">
                engine: <span className="text-accent">{voiceServerState.engine || '—'}</span>
                {' '}· whisper: <span className={voiceServerState.whisper?.loaded ? 'text-emerald-400' : 'text-neutral-400'}>{voiceServerState.whisper?.name || '—'}</span>
                {' '}· kokoro: <span className={voiceServerState.kokoro?.loaded ? 'text-emerald-400' : (voiceServerState.kokoro?.available ? 'text-neutral-400' : 'text-amber-500')}>{voiceServerState.kokoro?.loaded ? voiceServerState.kokoro?.voice : (voiceServerState.kokoro?.available ? 'ready' : 'not installed')}</span>
                {' '}· piper: <span className={voiceServerState.piper?.loaded ? 'text-emerald-400' : 'text-neutral-400'}>{voiceServerState.piper?.name || '—'}</span>
              </span>
            )}
          </div>

          {/* Whisper picker */}
          <div className="bg-bg-700 rounded-lg p-3 mb-2 space-y-2">
            <p className="text-[10px] font-semibold text-neutral-400 uppercase tracking-wider">Whisper (speech-to-text)</p>
            <div>
              <label className="text-[10px] text-neutral-500 block mb-1">Model size</label>
              <div className="flex gap-1">
                {['tiny', 'base', 'small', 'medium'].map(v => (
                  <button key={v} onClick={() => vc.setWhisperSize(v)}
                    className={`flex-1 text-[10px] py-1.5 rounded font-medium transition-colors ${vc.whisperSize === v ? 'bg-accent text-white' : 'btn-ghost'}`}>
                    {v}
                  </button>
                ))}
              </div>
              <p className="text-[9px] text-neutral-600 mt-1">
                {vc.whisperSize === 'tiny' && '~75 MB — fast, ok for short clear speech.'}
                {vc.whisperSize === 'base' && '~142 MB — recommended default.'}
                {vc.whisperSize === 'small' && '~466 MB — noticeably better accuracy.'}
                {vc.whisperSize === 'medium' && '~1.5 GB — slow but most accurate.'}
              </p>
            </div>
            <div className="flex items-center gap-1.5">
              <input type="text" value={vc.whisperPath} readOnly placeholder="(not downloaded yet)" className="input-field flex-1 text-[10px] truncate" title={vc.whisperPath} />
              <button onClick={browseWhisper} disabled={voiceBusy} className="btn btn-ghost p-1.5 shrink-0"><File size={13} /></button>
            </div>
            <button onClick={handleDownloadWhisper} disabled={voiceBusy}
              className="btn btn-ghost text-[10px] px-3 py-1.5 border border-accent/30 text-accent disabled:opacity-40">
              Download {vc.whisperSize}
            </button>
          </div>

          {/* TTS engine picker */}
          <div className="bg-bg-700 rounded-lg p-3 mb-2 space-y-2">
            <p className="text-[10px] font-semibold text-neutral-400 uppercase tracking-wider">TTS Engine</p>
            <div className="flex gap-1">
              {[
                { v: 'kokoro', label: 'Kokoro (natural, recommended)' },
                { v: 'piper',  label: 'Piper (fast, legacy)' },
              ].map(({ v, label }) => (
                <button key={v} onClick={() => vc.setEngine(v)}
                  className={`flex-1 text-[10px] py-1.5 rounded font-medium transition-colors ${vc.engine === v ? 'bg-accent text-white' : 'btn-ghost'}`}>
                  {label}
                </button>
              ))}
            </div>
            <p className="text-[9px] text-neutral-600">
              {vc.engine === 'kokoro'
                ? 'Kokoro-82M — sounds much closer to a human, runs near real-time on CPU, Apache 2.0. Weights auto-download (~330 MB) on first use.'
                : 'Piper — smallest & fastest, but prosody is flatter. Use if Kokoro install fails or you prefer the existing voice.'}
            </p>
          </div>

          {/* Kokoro picker */}
          <div className={`bg-bg-700 rounded-lg p-3 mb-2 space-y-2 ${vc.engine === 'kokoro' ? '' : 'opacity-60'}`}>
            <p className="text-[10px] font-semibold text-neutral-400 uppercase tracking-wider">Kokoro (text-to-speech)</p>
            <div>
              <label className="text-[10px] text-neutral-500 block mb-1">Voice</label>
              <select value={vc.kokoroVoice} onChange={e => vc.setKokoroVoice(e.target.value)} className="input-field text-[10px] w-full">
                <optgroup label="American English">
                  <option value="af_heart">af_heart — warm female (default)</option>
                  <option value="af_bella">af_bella — soft female</option>
                  <option value="af_nicole">af_nicole — clear female</option>
                  <option value="af_sarah">af_sarah — neutral female</option>
                  <option value="am_adam">am_adam — deep male</option>
                  <option value="am_michael">am_michael — warm male</option>
                </optgroup>
                <optgroup label="British English">
                  <option value="bf_emma">bf_emma — warm female</option>
                  <option value="bf_isabella">bf_isabella — soft female</option>
                  <option value="bm_george">bm_george — mature male</option>
                  <option value="bm_lewis">bm_lewis — young male</option>
                </optgroup>
              </select>
              <p className="text-[9px] text-neutral-600 mt-1">
                Voices share a single ~330 MB model — switching between voices is free after the first download.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <button onClick={handleDownloadKokoro} disabled={voiceBusy}
                className="btn btn-ghost text-[10px] px-3 py-1.5 border border-accent/30 text-accent disabled:opacity-40">
                Download / Warm Kokoro
              </button>
              <button onClick={handleTestTts} disabled={voiceBusy || vc.engine !== 'kokoro'}
                className="btn btn-ghost text-[10px] px-3 py-1.5 flex items-center gap-1 disabled:opacity-40">
                <Volume2 size={12} /> Test
              </button>
            </div>
          </div>

          {/* Piper picker */}
          <div className={`bg-bg-700 rounded-lg p-3 mb-2 space-y-2 ${vc.engine === 'piper' ? '' : 'opacity-60'}`}>
            <p className="text-[10px] font-semibold text-neutral-400 uppercase tracking-wider">Piper (text-to-speech)</p>
            <div>
              <label className="text-[10px] text-neutral-500 block mb-1">Voice</label>
              <select value={vc.piperVoice} onChange={e => vc.setPiperVoice(e.target.value)} className="input-field text-[10px] w-full">
                <option value="en_US-amy-medium">en_US · Amy (female, medium)</option>
                <option value="en_US-ryan-medium">en_US · Ryan (male, medium)</option>
                <option value="en_GB-alan-medium">en_GB · Alan (male, medium)</option>
                <option value="en_US-lessac-medium">en_US · Lessac (female, medium)</option>
              </select>
            </div>
            <div className="flex items-center gap-1.5">
              <input type="text" value={vc.piperPath} readOnly placeholder="(not downloaded yet)" className="input-field flex-1 text-[10px] truncate" title={vc.piperPath} />
              <button onClick={browsePiper} disabled={voiceBusy} className="btn btn-ghost p-1.5 shrink-0"><File size={13} /></button>
            </div>
            <div className="flex items-center gap-2">
              <button onClick={handleDownloadPiper} disabled={voiceBusy}
                className="btn btn-ghost text-[10px] px-3 py-1.5 border border-accent/30 text-accent disabled:opacity-40">
                Download voice
              </button>
              <button onClick={handleTestTts} disabled={voiceBusy || !vc.piperPath}
                className="btn btn-ghost text-[10px] px-3 py-1.5 flex items-center gap-1 disabled:opacity-40">
                <Volume2 size={12} /> Test
              </button>
            </div>
          </div>

          {voiceStatus && (
            <p className={`text-[10px] mt-2 ${voiceStatus.startsWith('Failed') ? 'text-red-400' : 'text-neutral-400'}`}>
              {voiceStatus}
            </p>
          )}
        </div>

        {/* ── ComfyUI Models ── */}
        <div className="panel p-4">
          <div className="panel-title mb-2">ComfyUI Models</div>
          <div className="space-y-1 text-[11px] text-neutral-500">
            <p><span className="text-neutral-400">Checkpoints:</span> {s.comfyCheckpoints.length}</p>
            <p><span className="text-neutral-400">LoRAs:</span> {s.comfyLoras.length}</p>
            <p><span className="text-neutral-400">CLIP:</span> {s.comfyClips.length}</p>
            <p><span className="text-neutral-400">VAE:</span> {s.comfyVaes.length}</p>
            <p><span className="text-neutral-400">Upscale:</span> {(s.comfyUpscaleModels || []).length}</p>
          </div>
        </div>

        {/* ── About ── */}
        <div className="panel p-4">
          <div className="panel-title mb-2">About</div>
          <div className="space-y-1.5 text-[11px]">
            <p className="text-neutral-300 font-semibold">AI-HUB</p>
            <p className="text-neutral-500">AI-powered image & video generation</p>
            <p className="text-neutral-600">Electron + React + Vite + ComfyUI</p>
          </div>
        </div>

      </div>
    </div>
  );
}
