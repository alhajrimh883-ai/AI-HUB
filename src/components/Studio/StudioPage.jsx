import React, { useEffect, useCallback, useRef, useState } from 'react';
import useSessionStore from '../../lib/sessionStore';
import useStudioSettings from '../../lib/studioStore';
import { STUDIO_RESOLUTIONS, QWEN_RESOLUTIONS, buildT2I, buildQwenT2I, T2I, QWEN_T2I } from '../../lib/studioWorkflow';
import useStore from '../../lib/store';
import usePresetStore from '../../lib/presetStore';
import * as comfy from '../../lib/comfyui';
import * as vlm from '../../lib/vlmClient';
import ImageOverlay from './ImageOverlay';
import StudioSettings from './StudioSettings';
import {
  Plus, Star, Trash2, ChevronDown,
  Settings, Loader2, Play, X, FolderOpen, Edit3,
} from 'lucide-react';

export default function StudioPage() {
  const ss = useSessionStore();
  const cfg = useStudioSettings();
  const vs = useStore();
  const wsRef = useRef(null);
  const [sessionDropdown, setSessionDropdown] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameDraft, setRenameDraft] = useState('');
  const [deleteConfirm, setDeleteConfirm] = useState(null);
  const [pkgDeleteConfirm, setPkgDeleteConfirm] = useState(null);
  const [overlayPkg, setOverlayPkg] = useState(null);
  const [overlayMode, setOverlayMode] = useState('view');
  const [showAnimSettings, setShowAnimSettings] = useState(false);

  // ── Init ──
  useEffect(() => {
    const init = async () => {
      if (!window.electronAPI) return;
      const settings = await window.electronAPI.loadSettings() || {};
      cfg.loadStudioSettings(settings);

      // Fetch model lists from ComfyUI API
      try {
        const [ckpts, loras] = await Promise.all([
          comfy.getCheckpoints(), comfy.getLoras(),
        ]);
        cfg.setComfyCheckpoints(ckpts || []);
        cfg.setComfyLoras(loras || []);
        console.log(`[Studio] ComfyUI: ${(ckpts||[]).length} checkpoints, ${(loras||[]).length} loras`);
      } catch (err) {
        console.error('[Studio] ComfyUI API query failed:', err);
      }

      // Load sessions
      const sessions = await window.electronAPI.sessionList();
      ss.setSessions(sessions);
      const lastId = await window.electronAPI.getLastSessionId();
      if (lastId && sessions.find(s => s.id === lastId)) await loadSession(lastId);
      else if (sessions.length > 0) await loadSession(sessions[0].id);
    };
    init();
  }, []);

  // ── Session management ──
  const loadSession = useCallback(async (id) => {
    if (!window.electronAPI) return;
    // Load session metadata
    const data = await window.electronAPI.sessionLoad(id);
    if (data) ss.setActiveSession(id, data.meta);

    // Migrate any legacy flat images to packages
    try { await window.electronAPI.pkgMigrateLegacy(id); } catch (e) { console.log('[Studio] Legacy migration:', e); }

    // Load packages
    const pkgs = await window.electronAPI.pkgList(id);
    ss.setPackages(pkgs || []);
    setSessionDropdown(false);
  }, []);

  const createSession = useCallback(async () => {
    if (!window.electronAPI) return;
    const meta = await window.electronAPI.sessionCreate('Untitled Session');
    const sessions = await window.electronAPI.sessionList();
    ss.setSessions(sessions); ss.setActiveSession(meta.id, meta); ss.setPackages([]);
    setSessionDropdown(false);
  }, []);

  const deleteSession = useCallback(async (id) => {
    if (!window.electronAPI) return;
    await window.electronAPI.sessionDelete(id);
    const sessions = await window.electronAPI.sessionList();
    ss.setSessions(sessions);
    if (ss.activeSessionId === id) {
      if (sessions.length > 0) await loadSession(sessions[0].id);
      else { ss.setActiveSession(null, null); ss.setPackages([]); }
    }
    setDeleteConfirm(null);
  }, [ss.activeSessionId]);

  const toggleFavorite = useCallback(async () => {
    if (!window.electronAPI || !ss.activeSessionId) return;
    const nf = !ss.activeSessionMeta?.favorite;
    await window.electronAPI.sessionUpdate(ss.activeSessionId, { favorite: nf });
    ss.setActiveSession(ss.activeSessionId, { ...ss.activeSessionMeta, favorite: nf });
    ss.setSessions(await window.electronAPI.sessionList());
  }, [ss.activeSessionId, ss.activeSessionMeta]);

  const renameSession = useCallback(async () => {
    if (!window.electronAPI || !ss.activeSessionId || !renameDraft.trim()) return;
    await window.electronAPI.sessionUpdate(ss.activeSessionId, { name: renameDraft.trim() });
    ss.setActiveSession(ss.activeSessionId, { ...ss.activeSessionMeta, name: renameDraft.trim() });
    ss.setSessions(await window.electronAPI.sessionList());
    setRenaming(false);
  }, [ss.activeSessionId, renameDraft]);

  // ── Metadata builder ──
  const buildMeta = (resKey, seed) => {
    const _ps = usePresetStore.getState();
    const _mode = cfg.studioMode || 'fast';
    const _preset = _ps.getSelectedPreset(_mode, 't2i');
    return {
      prompt: ss.studioPrompt,
      negativePrompt: _preset?.negPrompt || '',
      checkpoint: _preset?.models?.checkpoint || cfg.studioCheckpoint,
      steps: _preset?.settings?.steps ?? cfg.studioSteps,
      cfg: _preset?.settings?.cfg ?? cfg.studioCfg,
      seed,
      width: STUDIO_RESOLUTIONS[resKey]?.w || 1024,
      height: STUDIO_RESOLUTIONS[resKey]?.h || 1024,
      resolution: resKey,
      loras: (cfg.studioLoras || []).filter(l => l.enabled !== false).map(l => ({ name: l.name, strength: l.strength ?? 1 })),
      isHires: false,
    };
  };

  // ── Queue workflow and capture images from a target node ──
  async function queueAndCapture(workflow, targetNodeId) {
    return new Promise(async (resolve, reject) => {
      const capturedImages = [];
      const tracker = comfy.createSmartProgress(workflow);
      if (wsRef.current) wsRef.current.close();
      wsRef.current = comfy.connectWebSocket({
        onProgress: ({ value, max }) => {
          const p = tracker.onProgress(value, max);
          ss.setProgress(Math.round(p * 100), 100);
          vs.updateGenProgress(p);
        },
        onExecuting: (nid) => {
          if (nid !== null) {
            const p = tracker.onExecuting(nid);
            ss.setProgress(Math.round(p * 100), 100);
            vs.updateGenProgress(p);
          }
        },
        onExecuted: (nodeId, output) => {
          const p = tracker.onExecuted(nodeId);
          ss.setProgress(Math.round(p * 100), 100);
          vs.updateGenProgress(p);
          console.log(`[Studio] onExecuted node=${nodeId}, target=${targetNodeId}, images=${output?.images?.length || 0}`);
          if (nodeId === targetNodeId && output?.images) {
            for (const img of output.images) {
              console.log(`[Studio] Captured: ${img.filename}`);
              capturedImages.push({ filename: img.filename, subfolder: img.subfolder || '', type: img.type || 'temp' });
            }
          }
        },
        onComplete: () => {
          console.log(`[Studio] Complete: ${capturedImages.length} images captured`);
          resolve(capturedImages);
        },
        onError: (err) => reject(new Error(err?.message || 'Generation failed')),
      });
      try { await comfy.queuePrompt(workflow); } catch (err) { reject(err); }
    });
  }

  // ── Generate via ComfyUI ──
  const handleGenerate = useCallback(async () => {
    if (!ss.activeSessionId || !ss.studioPrompt.trim()) return;
    ss.setError(null); ss.setGenerating(true); ss.setProgress(0, 0);
    vs.startGeneration('studio', 'Studio: Generating images...');

    // Park VLM if loaded — free VRAM for ComfyUI
    await vlm.parkVlmIfLoaded();

    // Resolve T2I preset
    const presetStore = usePresetStore.getState();
    const mode = cfg.studioMode || 'fast';
    const t2iPreset = presetStore.getSelectedPreset(mode, 't2i');

    // ── Resolve preset fields ──
    const family = t2iPreset?.family || 'sdxl';
    const presetLoras = [...(t2iPreset?.loras || []), ...(cfg.studioLoras || [])];
    const presetSteps = t2iPreset?.settings?.steps ?? cfg.studioSteps;
    const presetCfg = t2iPreset?.settings?.cfg ?? cfg.studioCfg;
    const presetShift = t2iPreset?.settings?.shift;

    // ── Build workflow per family ──
    const buildWorkflow = (resKey, seed, batchSize) => {
      if (family === 'qwen_t2i') {
        return buildQwenT2I({
          prompt: ss.studioPrompt, negPrompt: t2iPreset?.negPrompt || '',
          resolution: resKey, seed, steps: presetSteps, cfg: presetCfg, shift: presetShift,
          batchSize, loras: presetLoras,
          unet: t2iPreset?.models?.unet || '', clip: t2iPreset?.models?.clip || '', vae: t2iPreset?.models?.vae || '',
        });
      }
      return buildT2I({
        prompt: ss.studioPrompt, negPrompt: t2iPreset?.negPrompt || '',
        resolution: resKey, seed, steps: presetSteps, cfg: presetCfg,
        batchSize, loras: presetLoras, checkpoint: t2iPreset?.models?.checkpoint || cfg.studioCheckpoint || '',
      });
    };

    const previewNode = family === 'qwen_t2i' ? QWEN_T2I.SAVE : T2I.PREVIEW;
    const resolutions = family === 'qwen_t2i' ? QWEN_RESOLUTIONS : STUDIO_RESOLUTIONS;

    try {
      const resKeys = Object.keys(resolutions);

      const createPkgFromCapture = async (img, meta) => {
        const pkg = await window.electronAPI.pkgCreate({
          sessionId: ss.activeSessionId,
          comfyFilename: img.filename, comfySubfolder: img.subfolder || '', comfyType: img.type || 'temp',
          metadata: meta,
        });
        ss.addPackage(pkg);
      };

      if (cfg.randomResolution || cfg.sequentialBatch) {
        for (let i = 0; i < ss.batchSize; i++) {
          const randKey = cfg.randomResolution ? resKeys[Math.floor(Math.random() * resKeys.length)] : (cfg.studioResolution || 'square');
          const seed = Math.floor(Math.random() * 2147483647);
          const wf = buildWorkflow(randKey, seed, 1);
          const images = await queueAndCapture(wf, previewNode);
          for (const img of images) await createPkgFromCapture(img, buildMeta(randKey, seed));
        }
      } else {
        const resKey = cfg.studioResolution || 'square';
        const seed = cfg.studioSeed || Math.floor(Math.random() * 2147483647);
        const wf = buildWorkflow(resKey, seed, ss.batchSize);
        const images = await queueAndCapture(wf, previewNode);
        for (const img of images) await createPkgFromCapture(img, buildMeta(resKey, seed));
      }
      vs.endGeneration('studio', 'Studio: Images generated!', 'success');
    } catch (err) {
      ss.setError(err.message);
      vs.endGeneration('studio', 'Studio generation failed', 'error');
    } finally {
      ss.setGenerating(false); ss.setProgress(0, 0);
    }
  }, [ss.activeSessionId, ss.studioPrompt, ss.batchSize, cfg]);

  // ── Delete package ──
  const handleDeletePkg = useCallback(async (pkgId) => {
    if (!window.electronAPI || !ss.activeSessionId || !pkgId) return;
    await window.electronAPI.pkgDelete({ sessionId: ss.activeSessionId, pkgId });
    ss.removePackage(pkgId);
    setPkgDeleteConfirm(null);
  }, [ss.activeSessionId]);

  return (
    <div className="flex-1 flex flex-col overflow-hidden relative">
      {/* Starry night sky */}
      <style>{`
        .starfield {
          position: absolute; inset: 0; overflow: hidden; pointer-events: none; z-index: 0;
          background: radial-gradient(ellipse at 50% 100%, rgba(25,18,8,0.08) 0%, transparent 50%),
                      radial-gradient(ellipse at 55% 15%, rgba(60,50,90,0.03) 0%, transparent 35%),
                      #040405;
        }
        .starfield::before {
          content: ''; position: absolute; inset: 0;
          background-image:
            radial-gradient(1px 1px at 10% 15%, rgba(255,255,255,0.7), transparent),
            radial-gradient(1px 1px at 25% 8%, rgba(255,255,255,0.5), transparent),
            radial-gradient(1.2px 1.2px at 40% 12%, rgba(200,210,255,0.6), transparent),
            radial-gradient(0.8px 0.8px at 55% 20%, rgba(255,255,255,0.4), transparent),
            radial-gradient(1px 1px at 70% 5%, rgba(255,255,255,0.6), transparent),
            radial-gradient(0.8px 0.8px at 85% 18%, rgba(255,255,255,0.3), transparent),
            radial-gradient(1.5px 1.5px at 48% 10%, rgba(180,170,255,0.5), transparent),
            radial-gradient(0.8px 0.8px at 15% 30%, rgba(255,255,255,0.3), transparent),
            radial-gradient(1px 1px at 35% 25%, rgba(255,255,255,0.5), transparent),
            radial-gradient(0.6px 0.6px at 60% 35%, rgba(255,255,255,0.25), transparent),
            radial-gradient(1px 1px at 80% 28%, rgba(255,255,255,0.4), transparent),
            radial-gradient(0.8px 0.8px at 5% 45%, rgba(255,255,255,0.2), transparent),
            radial-gradient(1px 1px at 90% 40%, rgba(255,255,255,0.35), transparent),
            radial-gradient(0.6px 0.6px at 30% 50%, rgba(255,255,255,0.15), transparent),
            radial-gradient(0.8px 0.8px at 65% 48%, rgba(255,255,255,0.2), transparent),
            radial-gradient(1px 1px at 45% 55%, rgba(255,255,255,0.15), transparent),
            radial-gradient(0.6px 0.6px at 20% 60%, rgba(255,255,255,0.1), transparent);
          background-size: 100% 100%;
        }
        .starfield::after {
          content: ''; position: absolute; inset: 0;
          background-image:
            radial-gradient(0.6px 0.6px at 12% 22%, rgba(255,255,255,0.35), transparent),
            radial-gradient(0.8px 0.8px at 28% 15%, rgba(255,255,255,0.25), transparent),
            radial-gradient(0.6px 0.6px at 42% 30%, rgba(255,255,255,0.2), transparent),
            radial-gradient(1px 1px at 58% 8%, rgba(255,240,200,0.4), transparent),
            radial-gradient(0.6px 0.6px at 73% 25%, rgba(255,255,255,0.2), transparent),
            radial-gradient(0.8px 0.8px at 88% 12%, rgba(255,255,255,0.3), transparent),
            radial-gradient(0.5px 0.5px at 8% 38%, rgba(255,255,255,0.15), transparent),
            radial-gradient(0.7px 0.7px at 52% 42%, rgba(200,200,255,0.2), transparent),
            radial-gradient(0.5px 0.5px at 78% 35%, rgba(255,255,255,0.12), transparent),
            radial-gradient(0.6px 0.6px at 95% 50%, rgba(255,255,255,0.1), transparent),
            radial-gradient(0.5px 0.5px at 38% 58%, rgba(255,255,255,0.08), transparent);
          background-size: 100% 100%;
          animation: twinkle 8s ease-in-out infinite alternate;
        }
        @keyframes twinkle { 0% { opacity: 0.6; } 100% { opacity: 1; } }
      `}</style>
      <div className="starfield" />

      {/* ── Package grid (masonry) ── */}
      <div className="flex-1 overflow-y-auto p-4 relative z-[1]">
        {!ss.activeSessionId ? (
          <div className="flex flex-col items-center justify-center h-full text-neutral-500">
            <FolderOpen size={48} className="mb-4 opacity-30" />
            <p className="text-sm font-medium">Create a session to get started</p>
            <button onClick={createSession} className="btn bg-accent/90 hover:bg-accent text-white mt-4 text-xs px-5 py-2 rounded-lg"><Plus size={13} /> New Session</button>
          </div>
        ) : ss.packages.length === 0 && !ss.generating ? (
          <div className="flex flex-col items-center justify-center h-full text-neutral-500">
            <p className="text-sm">No images yet — type a prompt and generate</p>
          </div>
        ) : (
          <div className="columns-2 lg:columns-3 xl:columns-4 gap-3 space-y-3">
            {ss.packages.map(pkg => {
              const root = pkg.root;
              const meta = root?.metadata;
              const totalVideos = (root?.videos?.length || 0) + (pkg.variants || []).reduce((s, v) => s + (v.videos?.length || 0), 0);
              const totalVariants = (pkg.variants || []).length;
              return (
                <div key={pkg.id} className="group relative rounded-lg overflow-hidden border border-transparent hover:border-accent/30 break-inside-avoid cursor-pointer transition-all hover:shadow-lg hover:shadow-accent/5"
                  onClick={() => { setOverlayPkg(pkg); setOverlayMode('view'); }}>
                  <img src={root?.preview || root?.thumb} alt={pkg.id} className="w-full h-auto block" loading="lazy" />
                  {/* Delete button */}
                  <button onClick={(e) => { e.stopPropagation();
                    if (cfg.skipDeleteConfirm) { handleDeletePkg(pkg.id); } else { setPkgDeleteConfirm(pkg.id); }
                  }} className="absolute bottom-1.5 right-1.5 bg-bg-900/80 hover:bg-red-600 text-neutral-600 hover:text-white rounded p-1 opacity-0 group-hover:opacity-100 transition-all z-[2]">
                    <Trash2 size={10} />
                  </button>
                  {totalVariants > 0 && <div className="absolute top-1.5 right-1.5 text-[9px] bg-purple-500/80 text-white rounded px-1 py-0.5">{totalVariants} variant{totalVariants > 1 ? 's' : ''}</div>}
                  {totalVideos > 0 && <div className="absolute top-1.5 right-10 text-[9px] bg-emerald-500/80 text-white rounded px-1 py-0.5 flex items-center gap-0.5">▶ {totalVideos}</div>}
                  {meta?.width && <div className="absolute top-1.5 left-1.5 text-[9px] bg-bg-900/70 text-neutral-400 rounded px-1 py-0.5">{meta.width}×{meta.height}</div>}
                  {meta?.seed > 0 && <div className="absolute bottom-1.5 left-1.5 text-[9px] bg-bg-900/70 text-neutral-500 rounded px-1 py-0.5 opacity-0 group-hover:opacity-100">seed: {meta.seed}</div>}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ── Prompt bar ── */}
      {ss.activeSessionId && (
        <div className="mx-4 mb-3 rounded-xl border border-white/[0.06] bg-white/[0.03] backdrop-blur-xl px-4 py-2.5 shrink-0 relative z-[1] shadow-2xl shadow-black/50">
          {ss.generating && ss.progressMax > 0 && (
            <div className="h-0.5 bg-white/[0.05] rounded-full overflow-hidden mb-2">
              <div className="h-full bg-gradient-to-r from-accent to-purple-400 rounded-full transition-all duration-300" style={{ width: `${Math.round((ss.progress / ss.progressMax) * 100)}%` }} />
            </div>
          )}
          <div className="flex items-end gap-2">
            {/* Session controls */}
            <div className="flex flex-col gap-0.5 shrink-0">
              <div className="relative">
                <button onClick={() => setSessionDropdown(!sessionDropdown)}
                  className="flex items-center gap-1 text-[10px] px-2 py-1 rounded-md max-w-[140px] text-neutral-400 hover:text-neutral-200 hover:bg-surface-light/50 transition-colors">
                  <FolderOpen size={10} />
                  {renaming ? (
                    <input type="text" value={renameDraft} onChange={(e) => setRenameDraft(e.target.value)}
                      onBlur={renameSession} onKeyDown={(e) => e.key === 'Enter' && renameSession()}
                      className="bg-transparent border-b border-accent text-[10px] text-neutral-200 outline-none w-20" autoFocus />
                  ) : (
                    <span className="truncate">{ss.activeSessionMeta?.name || 'No Session'}</span>
                  )}
                  <ChevronDown size={8} className="opacity-50" />
                </button>
                {sessionDropdown && (
                  <div className="absolute bottom-full left-0 mb-1 w-60 bg-bg-800 border border-surface-border rounded-lg shadow-2xl z-30 overflow-hidden">
                    <button onClick={createSession} className="w-full flex items-center gap-2 px-3 py-2 text-xs text-accent hover:bg-surface-light border-b border-surface-border">
                      <Plus size={12} /> New Session
                    </button>
                    <div className="max-h-44 overflow-y-auto">
                      {ss.sessions.map(s => (
                        <div key={s.id} className={`flex items-center gap-2 px-3 py-1.5 text-[10px] hover:bg-surface-light cursor-pointer ${s.id === ss.activeSessionId ? 'bg-accent/10 text-accent' : 'text-neutral-300'}`}>
                          <button onClick={() => loadSession(s.id)} className="flex-1 text-left truncate flex items-center gap-1.5">
                            {s.favorite && <Star size={9} className="text-yellow-500 fill-yellow-500 shrink-0" />}
                            <span className="truncate">{s.name}</span>
                            <span className="text-neutral-600 text-[9px] shrink-0">{s.imageCount}</span>
                          </button>
                          <button onClick={(e) => { e.stopPropagation(); setDeleteConfirm(s.id); }} className="text-neutral-600 hover:text-red-400 shrink-0"><Trash2 size={10} /></button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
              <div className="flex items-center gap-0.5 px-1.5">
                <button onClick={toggleFavorite} className={`p-0.5 ${ss.activeSessionMeta?.favorite ? 'text-yellow-500' : 'text-neutral-700 hover:text-yellow-500'}`}>
                  <Star size={10} className={ss.activeSessionMeta?.favorite ? 'fill-yellow-500' : ''} />
                </button>
                <button onClick={() => { setRenaming(true); setRenameDraft(ss.activeSessionMeta?.name || ''); }} className="text-neutral-700 hover:text-neutral-300 p-0.5"><Edit3 size={10} /></button>
                <span className="text-[7px] text-neutral-700 ml-0.5">{ss.packages.length}</span>
              </div>
            </div>
            {/* Prompt — auto-expanding */}
            <textarea value={ss.studioPrompt} onChange={(e) => {
              ss.setStudioPrompt(e.target.value);
              e.target.style.height = 'auto';
              e.target.style.height = Math.min(e.target.scrollHeight, 120) + 'px';
            }}
              placeholder="Describe what you want to see..."
              rows={1}
              className="flex-1 bg-white/[0.04] border border-white/[0.06] rounded-lg px-3 py-2 text-xs text-neutral-200 placeholder-neutral-600 outline-none focus:border-accent/30 focus:ring-1 focus:ring-accent/10 focus:bg-white/[0.06] transition-all resize-none overflow-hidden"
              style={{ minHeight: '34px', maxHeight: '120px' }}
              onKeyDown={(e) => { if (e.key === 'Enter' && e.ctrlKey) handleGenerate(); }} />
            {/* Controls */}
            <div className="flex flex-col items-end gap-1 shrink-0">
              <div className="flex items-center gap-1">
                <div className="relative">
                  <button onClick={() => setShowAnimSettings(!showAnimSettings)}
                    className={`text-[9px] px-2 py-1 rounded-md border font-medium flex items-center gap-1 transition-all ${
                      showAnimSettings ? 'bg-accent/15 border-accent/40 text-accent' : 'border-surface-border/40 text-neutral-500 hover:text-neutral-300 hover:border-surface-border'}`}>
                    <Settings size={9} /> Settings
                  </button>
                  {showAnimSettings && <StudioSettings onClose={() => setShowAnimSettings(false)} />}
                </div>
                <div className="w-px h-3.5 bg-surface-border/30" />
                {cfg.randomResolution && <span className="text-[8px] bg-amber-500/15 text-amber-400/80 px-1.5 py-0.5 rounded">RND</span>}
                {cfg.sequentialBatch && <span className="text-[8px] bg-blue-500/15 text-blue-400/80 px-1.5 py-0.5 rounded">SEQ</span>}
                {[1, 2, 4, 6].map(n => (
                  <button key={n} onClick={() => ss.setBatchSize(n)}
                    className={`text-[10px] w-5 h-5 rounded transition-all ${ss.batchSize === n ? 'bg-accent/80 text-white shadow-sm shadow-accent/30' : 'bg-bg-700/50 text-neutral-600 hover:text-neutral-400'}`}>{n}</button>
                ))}
              </div>
              {!ss.generating ? (
                <button onClick={handleGenerate} disabled={!vs.connected || !ss.studioPrompt.trim()}
                  className="bg-gradient-to-r from-accent via-purple-500 to-indigo-500 hover:from-accent/90 hover:via-purple-500/90 hover:to-indigo-500/90 text-white flex items-center gap-1.5 text-xs px-4 py-1.5 rounded-lg font-medium disabled:opacity-30 disabled:cursor-not-allowed transition-all shadow-md shadow-accent/20">
                  <Play size={12} /> Generate</button>
              ) : (
                <div className="flex items-center gap-2 px-2">
                  <Loader2 size={13} className="animate-spin text-accent" />
                  <span className="text-[10px] text-neutral-500">{ss.progressMax > 0 ? `${Math.round((ss.progress / ss.progressMax) * 100)}%` : 'Working...'}</span>
                </div>
              )}
            </div>
          </div>
          {ss.error && (
            <div className="mt-2 bg-red-500/[0.06] border border-red-500/20 rounded-lg p-2 flex items-start gap-2">
              <span className="text-[10px] text-red-300/80 flex-1">{ss.error}</span>
              <button onClick={() => ss.setError(null)} className="text-red-400/60 hover:text-red-300"><X size={11} /></button>
            </div>
          )}
        </div>
      )}

      {/* ── Overlay ── */}
      {overlayPkg && (
        <ImageOverlay
          pkg={overlayPkg}
          sessionId={ss.activeSessionId}
          onClose={() => { setOverlayPkg(null); setOverlayMode('view'); }}
          onPkgUpdated={(updatedPkg) => { ss.updatePackage(updatedPkg.id, updatedPkg); setOverlayPkg(updatedPkg); }}
          onPkgDeleted={(pkgId) => { ss.removePackage(pkgId); setOverlayPkg(null); }}
          key={overlayPkg.id + overlayMode}
          initialMode={overlayMode}
        />
      )}
      {deleteConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/60" onClick={() => setDeleteConfirm(null)} />
          <div className="relative bg-bg-800 border border-surface-border rounded-lg p-5 shadow-xl max-w-sm">
            <p className="text-sm text-neutral-200 mb-4">Delete this session and all its images?</p>
            <div className="flex justify-end gap-2">
              <button onClick={() => setDeleteConfirm(null)} className="btn btn-ghost text-xs">Cancel</button>
              <button onClick={() => deleteSession(deleteConfirm)} className="btn bg-red-600 text-white text-xs">Delete</button>
            </div>
          </div>
        </div>
      )}
      {pkgDeleteConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/60" onClick={() => setPkgDeleteConfirm(null)} />
          <div className="relative bg-bg-800 border border-surface-border rounded-xl p-5 shadow-xl max-w-sm">
            <p className="text-sm text-neutral-200 mb-1">Delete this image and all its variants?</p>
            <p className="text-[9px] text-neutral-600 mb-4">This cannot be undone.</p>
            <div className="flex justify-end gap-2">
              <button onClick={() => setPkgDeleteConfirm(null)} className="btn btn-ghost text-xs">Cancel</button>
              <button onClick={() => handleDeletePkg(pkgDeleteConfirm)} className="btn bg-red-600 text-white text-xs">Delete</button>
            </div>
            <p className="text-[8px] text-neutral-700 mt-3 text-center">This popup can be disabled in Settings</p>
          </div>
        </div>
      )}
    </div>
  );
}
