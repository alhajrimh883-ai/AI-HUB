import React, { useEffect, useRef, useState } from 'react';
import { X, Trash2 } from 'lucide-react';

const MAX_LOGS = 500;

// Global log buffer — persists even when overlay is closed
const logBuffers = { app: [], comfyui: [], vlm: [] };
const listeners = new Set();

export function addLog(source, msg) {
  const entry = {
    msg: typeof msg === 'string' ? msg : JSON.stringify(msg),
    time: new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }),
  };
  const buf = logBuffers[source] || logBuffers.app;
  buf.push(entry);
  if (buf.length > MAX_LOGS) buf.splice(0, buf.length - MAX_LOGS);
  listeners.forEach(fn => fn());
}

// Intercept console.log/warn/error to capture app-level logs
const _origLog = console.log;
const _origWarn = console.warn;
const _origError = console.error;
let interceptInstalled = false;

function installIntercept() {
  if (interceptInstalled) return;
  interceptInstalled = true;

  console.log = (...args) => {
    _origLog(...args);
    const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
    // Route to correct buffer based on prefix
    if (msg.includes('[VLM')) addLog('vlm', msg);
    else if (msg.includes('[ComfyUI]')) addLog('comfyui', msg);
    else addLog('app', msg);
  };
  console.warn = (...args) => {
    _origWarn(...args);
    const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
    addLog('app', `⚠ ${msg}`);
  };
  console.error = (...args) => {
    _origError(...args);
    const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
    addLog('app', `✕ ${msg}`);
  };
}

// Install immediately on import
installIntercept();
addLog('app', 'Log system initialized');

// IPC listener for main process logs — install early with retry
let ipcInstalled = false;
function installIpc() {
  if (ipcInstalled || !window.electronAPI?.onLogMessage) return;
  ipcInstalled = true;
  window.electronAPI.onLogMessage((data) => {
    addLog(data.source, data.message);
  });
  addLog('app', 'IPC log bridge connected');
}
// Try immediately, then retry after Electron preload is ready
installIpc();
setTimeout(installIpc, 500);
setTimeout(installIpc, 2000);

export default function LogsOverlay({ onClose }) {
  const [, forceUpdate] = useState(0);
  const scrollRef = useRef(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const [activeTab, setActiveTab] = useState('all');

  useEffect(() => {
    installIpc();
    const update = () => forceUpdate(n => n + 1);
    listeners.add(update);
    return () => listeners.delete(update);
  }, []);

  useEffect(() => {
    const handler = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  useEffect(() => {
    if (autoScroll && scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  });

  const colorLine = (msg) => {
    if (msg.includes('ERROR') || msg.includes('Error') || msg.includes('error')) return 'text-red-400';
    if (msg.includes('WARNING') || msg.includes('Warning')) return 'text-amber-400';
    if (msg.includes('[OK]') || msg.includes('ready') || msg.includes('done') || msg.includes('complete')) return 'text-green-400';
    if (msg.includes('[VLM')) return 'text-amber-300';
    if (msg.includes('[ComfyUI]') || msg.includes('[LongVideo]') || msg.includes('[Studio]')) return 'text-cyan-300';
    return 'text-neutral-400';
  };

  const srcColor = { app: 'text-cyan-500', comfyui: 'text-emerald-500', vlm: 'text-amber-500' };

  const clearAll = () => {
    logBuffers.app.length = 0;
    logBuffers.comfyui.length = 0;
    logBuffers.vlm.length = 0;
    forceUpdate(n => n + 1);
  };

  // Merge and sort all logs for "All" tab
  const getLogs = () => {
    if (activeTab === 'all') {
      return [
        ...logBuffers.app.map(l => ({ ...l, src: 'app' })),
        ...logBuffers.comfyui.map(l => ({ ...l, src: 'comfyui' })),
        ...logBuffers.vlm.map(l => ({ ...l, src: 'vlm' })),
      ].sort((a, b) => a.time.localeCompare(b.time));
    }
    return (logBuffers[activeTab] || []).map(l => ({ ...l, src: activeTab }));
  };

  const logs = getLogs();
  const emptyMessages = {
    all: 'No logs yet. Logs appear during generation, VLM inference, and ComfyUI operations.',
    app: 'App logs appear during generation, workflow building, and VLM pipeline steps.',
    comfyui: 'ComfyUI logs appear when launched from Settings. If started manually, output goes to its own terminal.',
    vlm: 'VLM logs appear when VLM is used for prompt generation.',
  };

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black/90 backdrop-blur-sm no-drag" style={{ WebkitAppRegion: 'no-drag' }}>
      <div className="flex items-center justify-between px-4 py-2 border-b border-surface-border bg-bg-800 shrink-0">
        <div className="flex items-center gap-3">
          <h2 className="text-sm font-bold text-neutral-200">Logs</h2>
          <div className="flex bg-bg-700 rounded p-0.5">
            {[
              { id: 'all', label: 'All' },
              { id: 'app', label: 'App', color: 'text-cyan-400' },
              { id: 'comfyui', label: 'ComfyUI', color: 'text-emerald-400' },
              { id: 'vlm', label: 'VLM', color: 'text-amber-400' },
            ].map(tab => (
              <button key={tab.id} onClick={() => setActiveTab(tab.id)}
                className={`px-2.5 py-0.5 text-[10px] rounded transition-colors ${
                  activeTab === tab.id ? 'bg-bg-600 text-white' : 'text-neutral-600 hover:text-neutral-400'}`}>
                {tab.label}
                <span className="text-[8px] opacity-50 ml-1">{logBuffers[tab.id]?.length || (tab.id === 'all' ? logs.length : 0)}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-1.5 text-[10px] text-neutral-500 cursor-pointer">
            <input type="checkbox" checked={autoScroll} onChange={(e) => setAutoScroll(e.target.checked)} className="w-3 h-3 rounded" />
            Auto-scroll
          </label>
          <button onClick={clearAll} className="btn btn-ghost text-[10px] px-2 py-1 text-neutral-500 flex items-center gap-1 hover:text-white">
            <Trash2 size={10} /> Clear
          </button>
          <button onClick={onClose} className="text-neutral-400 hover:text-white hover:bg-red-600/50 rounded p-1.5 transition-colors" title="Close (ESC)">
            <X size={18} />
          </button>
        </div>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto p-2 font-mono text-[10px] leading-relaxed">
        {logs.length === 0 ? (
          <p className="text-neutral-700 text-center mt-8">{emptyMessages[activeTab]}</p>
        ) : logs.map((log, i) => (
          <div key={i} className="flex gap-2 hover:bg-bg-700/50">
            <span className="text-neutral-700 shrink-0 select-none">{log.time}</span>
            {activeTab === 'all' && (
              <span className={`shrink-0 w-8 text-[9px] uppercase ${srcColor[log.src] || 'text-neutral-600'}`}>
                {log.src === 'comfyui' ? 'cfui' : log.src}
              </span>
            )}
            <span className={colorLine(log.msg)}>{log.msg}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
