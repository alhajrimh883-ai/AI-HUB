import React, { useEffect, useRef, useCallback, useState } from 'react';
import LogsOverlay, { addLog } from './components/LogsOverlay';
import useStore from './lib/store';
import useStudioSettings from './lib/studioStore';
import usePresetStore from './lib/presetStore';
import * as vlm from './lib/vlmClient';
import * as comfy from './lib/comfyui';
import StudioPage from './components/Studio/StudioPage';
import DirectorPage from './components/Director/DirectorPage';
import AppSettingsPage from './components/AppSettings/AppSettingsPage';
import GalleryPage from './components/Gallery/GalleryPage';
import PresetsPage from './components/Presets/PresetsPage';
import ChatPage from './components/Chat/ChatPage';
import WelcomePage from './components/Welcome/WelcomePage';
import ErrorBoundary from './components/ErrorBoundary';
import {
  Settings, LayoutGrid, X, Terminal, FolderOpen, Wand2, Loader2, Zap, Layers, RefreshCw, Brain, ChevronDown, MessageSquare,
} from 'lucide-react';



export default function App() {
  const store = useStore();
  const ps = usePresetStore();
  const wsRef = useRef(null);
  const [appMode, setAppMode] = useState('studio');
  const [showLogs, setShowLogs] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [vlmDropdown, setVlmDropdown] = useState(false);
  // First-run wizard gate. `null` until we've read settings.json (so we
  // don't flash the welcome screen for returning users); `true` means we
  // should show the wizard; `false` means skip it.
  const [showWelcome, setShowWelcome] = useState(null);

  // Catch any uncaught error / unhandled rejection so we at least log it to
  // the console before React potentially tears down the tree. Particularly
  // useful for debugging renderer-side crashes that don't come through a
  // component boundary (e.g. getUserMedia, MediaRecorder, async side-effects).
  useEffect(() => {
    const onError = (ev) => { console.error('[window.error]', ev.error || ev.message, ev); };
    const onReject = (ev) => { console.error('[unhandledrejection]', ev.reason, ev); };
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onReject);
    return () => {
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onReject);
    };
  }, []);

  const refreshModels = useCallback(async () => {
    setRefreshing(true);
    try {
      const ckpts = await comfy.getCheckpoints();
      const loras = await comfy.getLoras();
      store.setComfyCheckpoints(ckpts);
      store.setComfyLoras(loras);
      useStudioSettings.getState().setComfyCheckpoints(ckpts);
      useStudioSettings.getState().setComfyLoras(loras);
      try { store.setComfyClips(await comfy.getClipModels()); } catch {}
      try { store.setComfyVaes(await comfy.getVaeModels()); } catch {}
      try { store.setComfyUnets(await comfy.getUnetModels()); } catch {}
    } catch {}
    setTimeout(() => setRefreshing(false), 400);
  }, []);

  // Long Video: smart progress tracking

  // ── Connection check + auto-launch ComfyUI ──
  const comfyLaunchAttempted = useRef(false);
  useEffect(() => {
    const check = async () => {
      const connected = await comfy.checkConnection();
      const wasConnected = useStore.getState().connected;
      store.setConnected(connected);
      if (connected !== wasConnected) {
        addLog('comfyui', connected ? 'Connected to ComfyUI' : 'Disconnected from ComfyUI');
      }

      // Auto-launch ComfyUI if not connected and launcher path is set
      if (!connected && !comfyLaunchAttempted.current && window.electronAPI?.comfyLaunch) {
        const launcherPath = useStore.getState().comfyLauncherPath;
        if (launcherPath) {
          comfyLaunchAttempted.current = true;
          console.log('[App] ComfyUI not running, auto-launching:', launcherPath);
          store.setComfyLaunchStatus('Starting ComfyUI...');
          const result = await window.electronAPI.comfyLaunch({ launcherPath });
          if (result.status === 'ok' || result.status === 'already_running') {
            console.log('[App] ComfyUI launched successfully');
            store.setComfyLaunchStatus('');
            store.setConnected(true);
          } else {
            console.error('[App] ComfyUI launch failed:', result.error);
            store.setComfyLaunchStatus(result.error || 'Launch failed');
          }
        }
      }
    };
    check(); const iv = setInterval(check, 5000); return () => clearInterval(iv);
  }, []);

  // ── Auto-dismiss toasts after 8s ──
  useEffect(() => {
    if (store.toasts.length === 0) return;
    const timer = setTimeout(() => {
      const s = useStore.getState();
      const oldest = s.toasts[0];
      if (oldest && Date.now() - oldest.timestamp > 7000) s.dismissToast(oldest.id);
    }, 8000);
    return () => clearTimeout(timer);
  }, [store.toasts]);

  // ── Load settings + model lists ──
  useEffect(() => {
    const init = async () => {
      if (!window.electronAPI) { setShowWelcome(false); return; }
      const data = await window.electronAPI.loadSettings();
      // Decide whether to show the first-run wizard BEFORE we finish
      // hydrating stores — so users get the welcome screen on the very
      // first launch without the rest of the app flashing behind it.
      setShowWelcome(!(data && data.firstRunDone));
      if (data) {
        store.loadPersistedState(data);
        useStudioSettings.getState().loadStudioSettings(data);
        // Director settings
        const { default: useDirectorStore } = await import('./lib/directorStore');
        useDirectorStore.getState().loadPersistedState(data);
        // Preset store
        const { default: usePresetStore } = await import('./lib/presetStore');
        usePresetStore.getState().loadPersistedState(data);
        // Chat store
        const { default: useChatStore } = await import('./lib/chatStore');
        useChatStore.getState().loadPersistedState(data);
        // Voice store
        const { default: useVoiceStore } = await import('./lib/voiceStore');
        useVoiceStore.getState().loadPersistedState(data);
        console.log('[Settings] Loaded presets:', data.modelPresets?.length || 0, 'active:', data.activePresetFast, data.activePresetQuality);
      }
      // Scan media
      try { store.setAvailableImages(await window.electronAPI.scanImages()); } catch {}
      try { store.setAvailableVideos(await window.electronAPI.scanVideos()); } catch {}
    };
    init();
  }, []);

  // ── Fetch ComfyUI model lists (initial + poll every 30s for changes) ──
  useEffect(() => {
    if (!store.connected) return;
    const load = async () => {
      try {
        const ckpts = await comfy.getCheckpoints();
        store.setComfyCheckpoints(ckpts);
        useStudioSettings.getState().setComfyCheckpoints(ckpts);
      } catch {}
      try {
        const loras = await comfy.getLoras();
        store.setComfyLoras(loras);
        useStudioSettings.getState().setComfyLoras(loras);
      } catch {}
      try { store.setComfyClips(await comfy.getClipModels()); } catch {}
      try { store.setComfyVaes(await comfy.getVaeModels()); } catch {}
      try { store.setComfyUnets(await comfy.getUnetModels()); } catch {}
      try { store.setComfyLtxAudioVaes(await comfy.getLtxAudioVaeModels()); } catch {}
    };
    load();
    const iv = setInterval(load, 30000);
    return () => clearInterval(iv);
  }, [store.connected]);

  // ── Scan upscale model folders (filesystem — poll every 30s) ──
  useEffect(() => {
    if (!window.electronAPI) return;
    const scan = async () => {
      try {
        const upscale = await window.electronAPI.scanUpscaleModels();
        store.setComfyUpscaleModels((upscale || []).map(m => m.path || m.name));
      } catch {}
      try {
        const latent = await window.electronAPI.scanLatentUpscaleModels();
        store.setComfyLatentUpscaleModels((latent || []).map(m => m.path || m.name));
      } catch {}
    };
    scan();
    const iv = setInterval(scan, 30000);
    return () => clearInterval(iv);
  }, []);


  // First-run wizard takes over the whole UI on first launch. We render
  // the normal app tree behind it (so it's ready to go when the user
  // hits "Continue") but the fullscreen overlay covers everything.
  if (showWelcome) {
    return (
      <ErrorBoundary>
        <WelcomePage onDone={() => setShowWelcome(false)} />
      </ErrorBoundary>
    );
  }

  return (
    <div className="h-screen flex flex-col bg-bg-900 text-white">
      {/* ── Header ── */}
      <div className="h-10 flex items-center px-4 border-b border-surface-border bg-bg-800 shrink-0 drag select-none">
        <div className="flex items-center gap-2 no-drag">
          <Zap size={14} className="text-accent" />
          <span className="text-xs font-bold tracking-wide">AI-HUB</span>
          <button onClick={() => setShowLogs(!showLogs)}
            className={`flex items-center gap-1 px-2 py-0.5 rounded text-[10px] transition-colors ml-2 ${
              showLogs ? 'bg-accent/20 text-accent' : 'text-neutral-600 hover:text-neutral-400'}`}>
            <Terminal size={11} /> Logs
          </button>
          <button onClick={refreshModels} title="Refresh model lists"
            className="flex items-center gap-1 px-2 py-0.5 rounded text-[10px] text-neutral-600 hover:text-neutral-400 transition-colors">
            <RefreshCw size={11} className={refreshing ? 'animate-spin text-accent' : ''} /> Models
          </button>
          {/* VLM Preset selector */}
          <div className="relative ml-1">
            <button onClick={() => setVlmDropdown(!vlmDropdown)}
              className={`flex items-center gap-1 px-2 py-0.5 rounded text-[10px] transition-colors ${
                ps.selectedPresets?.both?.vlm
                  ? 'text-emerald-400 hover:text-emerald-300'
                  : 'text-amber-500 hover:text-amber-400'
              }`}>
              <Brain size={11} />
              <span className="max-w-[100px] truncate">
                {ps.selectedPresets?.both?.vlm
                  ? ps.presets.find(p => p.id === ps.selectedPresets.both.vlm)?.name || 'VLM'
                  : 'No VLM'}
              </span>
              <ChevronDown size={8} className="opacity-50" />
            </button>
            {vlmDropdown && (
              <div className="absolute top-full left-0 mt-1 w-56 bg-bg-800 border border-surface-border rounded-lg shadow-2xl z-50 overflow-hidden">
                <div className="px-3 py-1.5 border-b border-surface-border text-[9px] text-neutral-500 uppercase tracking-wider">VLM Preset</div>
                <button onClick={() => { ps.setSelectedPreset('both', 'vlm', ''); setVlmDropdown(false); }}
                  className={`w-full text-left px-3 py-1.5 text-[10px] hover:bg-surface-light ${!ps.selectedPresets?.both?.vlm ? 'text-amber-400' : 'text-neutral-400'}`}>
                  None (VLM features disabled)
                </button>
                {ps.presets.filter(p => p.type === 'vlm').map(p => (
                  <button key={p.id} onClick={() => { ps.setSelectedPreset('both', 'vlm', p.id); setVlmDropdown(false); }}
                    className={`w-full text-left px-3 py-1.5 text-[10px] hover:bg-surface-light truncate ${
                      ps.selectedPresets?.both?.vlm === p.id ? 'text-emerald-400 bg-emerald-500/5' : 'text-neutral-300'
                    }`}>
                    {p.name}
                    {p.models?.vlmModel && <span className="text-[8px] text-neutral-600 ml-1">({p.models.vlmModel.split(/[/\\]/).pop()})</span>}
                  </button>
                ))}
                {ps.presets.filter(p => p.type === 'vlm').length === 0 && (
                  <p className="px-3 py-2 text-[9px] text-neutral-600">No VLM presets. Create one in Presets tab.</p>
                )}
              </div>
            )}
          </div>
        </div>
        <div className="flex-1" />
        <div className="flex items-center bg-bg-700 rounded-md p-0.5 no-drag">
          {[
            { id: 'studio', icon: LayoutGrid, label: 'Studio' },
            { id: 'director', icon: Wand2, label: 'AI Director' },
            { id: 'chat', icon: MessageSquare, label: 'Chat' },
            { id: 'presets', icon: Layers, label: 'Presets' },
            { id: 'gallery', icon: FolderOpen, label: 'Gallery' },
            { id: 'settings', icon: Settings, label: 'Settings' },
          ].map(tab => (
            <button key={tab.id} onClick={() => setAppMode(tab.id)}
              className={`flex items-center gap-1.5 px-3 py-1 rounded text-[11px] font-medium transition-colors ${
                appMode === tab.id ? 'bg-accent text-white' : 'text-neutral-500 hover:text-neutral-300'}`}>
              <tab.icon size={12} /> {tab.label}
            </button>
          ))}
        </div>
        <div className="flex-1" />
        <div className="flex items-center gap-3 no-drag">
          <div className={`w-2 h-2 rounded-full ${store.connected ? 'bg-green-400' : 'bg-red-500 animate-pulse'}`}
            title={store.connected ? 'ComfyUI connected' : 'ComfyUI disconnected'} />
          {store.comfyLaunchStatus && !store.connected && (
            <span className="text-[9px] text-amber-400 animate-pulse">{store.comfyLaunchStatus}</span>
          )}
          {/* Window controls */}
          <div className="flex items-center ml-2 -mr-2">
            <button onClick={() => window.electronAPI?.winMinimize()}
              className="w-10 h-10 flex items-center justify-center text-neutral-500 hover:text-white hover:bg-neutral-700 transition-colors">
              <svg width="10" height="1" viewBox="0 0 10 1"><rect width="10" height="1" fill="currentColor"/></svg>
            </button>
            <button onClick={async () => { await window.electronAPI?.winMaximize(); }}
              className="w-10 h-10 flex items-center justify-center text-neutral-500 hover:text-white hover:bg-neutral-700 transition-colors">
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1"><rect x="0.5" y="0.5" width="9" height="9"/></svg>
            </button>
            <button onClick={() => window.electronAPI?.winClose()}
              className="w-10 h-10 flex items-center justify-center text-neutral-500 hover:text-white hover:bg-red-600 transition-colors">
              <svg width="10" height="10" viewBox="0 0 10 10" stroke="currentColor" strokeWidth="1.2"><line x1="0" y1="0" x2="10" y2="10"/><line x1="10" y1="0" x2="0" y2="10"/></svg>
            </button>
          </div>
        </div>
      </div>

      {/* ── Global Generation Bar ── */}
      {store.activeGen && (
        <div className="flex items-center gap-3 px-4 py-1.5 bg-bg-700 border-b border-surface-border shrink-0 no-drag">
          <Loader2 size={12} className="animate-spin text-accent shrink-0" />
          <span className="text-[10px] text-neutral-300 shrink-0">{store.activeGen.label}</span>
          <div className="flex-1 h-1 bg-bg-900 rounded-full overflow-hidden">
            <div className="h-full bg-accent rounded-full transition-all duration-300" style={{ width: `${Math.round(store.activeGen.progress * 100)}%` }} />
          </div>
          <span className="text-[10px] text-neutral-500 w-8 text-right">{Math.round(store.activeGen.progress * 100)}%</span>
          {store.activeGen.source !== appMode && (
            <button onClick={() => setAppMode(store.activeGen.source === 'longvideo' ? 'video' : store.activeGen.source)}
              className="text-[9px] text-accent hover:text-white px-1.5 py-0.5 rounded border border-accent/30">Show</button>
          )}
          <button onClick={() => { comfy.interrupt(); store.endGeneration(store.activeGen.source, 'Generation cancelled', 'info'); }}
            className="text-[9px] text-red-400 hover:text-white hover:bg-red-600 px-1.5 py-0.5 rounded border border-red-500/30">Cancel</button>
        </div>
      )}

      {/* ── Toast Notifications ── */}
      {store.toasts.length > 0 && (
        <div className="fixed bottom-4 right-4 z-50 space-y-2 no-drag" style={{ WebkitAppRegion: 'no-drag' }}>
          {store.toasts.map(t => (
            <div key={t.id} className={`flex items-center gap-2 px-3 py-2 rounded-lg shadow-xl border backdrop-blur-sm min-w-[250px] animate-[slideIn_0.3s_ease-out] ${
              t.type === 'success' ? 'bg-emerald-900/90 border-emerald-700 text-emerald-200' :
              t.type === 'error' ? 'bg-red-900/90 border-red-700 text-red-200' :
              'bg-bg-800/90 border-surface-border text-neutral-300'}`}>
              <span className="text-[11px] flex-1">{t.message}</span>
              {t.source && (
                <button onClick={() => { setAppMode(t.source === 'longvideo' ? 'video' : t.source); store.dismissToast(t.id); }}
                  className="text-[9px] text-accent hover:text-white px-1.5 py-0.5 rounded border border-accent/30">Show</button>
              )}
              <button onClick={() => store.dismissToast(t.id)} className="text-neutral-500 hover:text-white"><X size={12} /></button>
            </div>
          ))}
        </div>
      )}

      {/* ── Content ── */}
      {/* Each page is wrapped in ErrorBoundary so a render crash inside (e.g.
          a Chat-tool throw, a bad preset config, a missing image field) shows
          a readable error panel instead of unmounting the whole app — the
          previous "blank window on mic click" failure mode. */}
      <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
        {appMode === 'studio' && <ErrorBoundary label="Studio"><StudioPage /></ErrorBoundary>}
        {appMode === 'gallery' && <ErrorBoundary label="Gallery"><GalleryPage /></ErrorBoundary>}
        {appMode === 'settings' && <ErrorBoundary label="Settings"><AppSettingsPage /></ErrorBoundary>}
        {appMode === 'presets' && <ErrorBoundary label="Presets"><PresetsPage /></ErrorBoundary>}
        {appMode === 'director' && <ErrorBoundary label="Director"><DirectorPage /></ErrorBoundary>}
        {appMode === 'chat' && <ErrorBoundary label="Chat"><ChatPage /></ErrorBoundary>}
      </div>
      {showLogs && <LogsOverlay onClose={() => setShowLogs(false)} />}
    </div>
  );
}

