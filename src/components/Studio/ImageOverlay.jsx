import React, { useState, useRef, useEffect, useCallback } from 'react';
import useStudioSettings from '../../lib/studioStore';
import useStore from '../../lib/store';
import usePresetStore from '../../lib/presetStore';
import { buildEditorOverlay } from '../../lib/editorWorkflow';
import { buildI2V } from '../../lib/sviproWorkflow';
import * as comfy from '../../lib/comfyui';
import { parkVlmIfLoaded } from '../../lib/vlmClient';
import { copyToClipboard } from '../../lib/clipboard';
import { addLog } from '../LogsOverlay';
import {
  X, Sparkles, Trash2, Copy, Check, Pencil, Film,
  Download, Play, Loader2, ZoomIn, ZoomOut, RotateCcw, Image as ImageIcon,
} from 'lucide-react';

function CompareSlider({ originalSrc, resultSrc, label }) {
  const [pos, setPos] = useState(50);
  const dragging = useRef(false);
  const ref = useRef(null);
  const onMove = (e) => {
    if (!dragging.current || !ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    const x = e.touches ? e.touches[0].clientX : e.clientX;
    setPos(Math.max(0, Math.min(100, ((x - rect.left) / rect.width) * 100)));
  };
  useEffect(() => {
    const up = () => { dragging.current = false; };
    window.addEventListener('mouseup', up); window.addEventListener('touchend', up);
    return () => { window.removeEventListener('mouseup', up); window.removeEventListener('touchend', up); };
  }, []);
  return (
    <div ref={ref} className="relative w-full h-full select-none cursor-col-resize overflow-hidden"
      onMouseMove={onMove} onTouchMove={onMove} onMouseDown={() => { dragging.current = true; }} onTouchStart={() => { dragging.current = true; }}>
      <img src={resultSrc} className="w-full h-full object-contain" />
      <div className="absolute inset-0 overflow-hidden" style={{ clipPath: `inset(0 ${100 - pos}% 0 0)` }}>
        <img src={originalSrc} className="w-full h-full object-contain" />
      </div>
      <div className="absolute top-0 bottom-0 w-0.5 bg-white/80" style={{ left: `${pos}%` }}>
        <div className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-7 h-7 bg-white/90 rounded-full flex items-center justify-center shadow-lg">
          <span className="text-black text-[10px] font-bold">⇔</span>
        </div>
      </div>
      <div className="absolute top-2 left-2 bg-black/60 rounded px-1.5 py-0.5 text-[9px] text-neutral-300">Original</div>
      <div className="absolute top-2 right-2 bg-black/60 rounded px-1.5 py-0.5 text-[9px] text-accent">{label}</div>
    </div>
  );
}

export default function ImageOverlay({
  pkg, sessionId, onClose, onPkgUpdated, onPkgDeleted,

  initialMode,
}) {
  const cfg = useStudioSettings();
  const ps = usePresetStore();
  const [animVlmMode, setAnimVlmMode] = useState('off'); // 'off' | 'guided' | 'auto'
  const vs = useStore();
  const wsRef = useRef(null);

  // ── State ──
  const [selectedNode, setSelectedNode] = useState('root');
  const [generating, setGenerating] = useState(false);
  const [progress, setProgress] = useState(0);
  const [compResult, setCompResult] = useState(null); // { preview } for comparison
  const [videoUrl, setVideoUrl] = useState(null);
  const [editPrompt, setEditPrompt] = useState('');
  const [animPrompt, setAnimPrompt] = useState('');
  const [error, setError] = useState(null);
  const [copied, setCopied] = useState(null);
  const [activePanel, setActivePanel] = useState(initialMode === 'view' ? null : initialMode || null);
  const [showVideo, setShowVideo] = useState(false);
  const [videoIdx, setVideoIdx] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const dragStart = useRef({ x: 0, y: 0, panX: 0, panY: 0 });

  // VLM
  const [vlmPhase, setVlmPhase] = useState('idle');
  const [vlmStatus, setVlmStatus] = useState('');
  const [vlmPrompt, setVlmPrompt] = useState('');

  // Hires
  const [hiresPromptMode, setHiresPromptMode] = useState('auto');
  const [hiresManualPrompt, setHiresManualPrompt] = useState('');
  const [hiresManualNeg, setHiresManualNeg] = useState('');

  // Guided mode

  // Smart progress
  const smartTracker = useRef(null);
  const mountedRef = useRef(true);
  const resetProgress = () => { smartTracker.current = null; setProgress(0); };

  // Cleanup on unmount — only close WS if NOT generating (let it finish saving)
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (wsRef.current && !generating) { wsRef.current.close(); wsRef.current = null; }
    };
  }, [generating]);

  // ── Derived from package ──
  const currentNode = selectedNode === 'root' ? pkg.root : pkg.variants?.find(v => v.id === selectedNode);
  const meta = currentNode?.metadata || {};
  const nodeVideos = currentNode?.videos || [];
  const currentVideo = nodeVideos[videoIdx];
  const pp = progress;
  
  const copyText = async (t, k) => {
    const ok = await copyToClipboard(t);
    if (ok) { setCopied(k); setTimeout(() => setCopied(null), 1500); }
    else addLog('Clipboard', 'Copy failed — clipboard unavailable');
  };

  // Safe state update — only if component is still mounted
  const safeSet = (fn) => { if (mountedRef.current) fn(); };

  // ── Smart connect helper ──
  const smartConnect = (wf, cbs = {}) => {
    smartTracker.current = comfy.createSmartProgress(wf);
    if (wsRef.current) wsRef.current.close();
    return comfy.connectWebSocket({
      onProgress: ({ value, max }) => { if (smartTracker.current) { const p = smartTracker.current.onProgress(value, max); if (mountedRef.current) setProgress(p); vs.updateGenProgress(p); } },
      onExecuting: (nid) => { if (smartTracker.current) { const p = smartTracker.current.onExecuting(nid); if (mountedRef.current) setProgress(p); vs.updateGenProgress(p); } cbs.onExecuting?.(nid); },
      onExecuted: (nid, o) => { if (smartTracker.current) { const p = smartTracker.current.onExecuted(nid); if (mountedRef.current) setProgress(p); vs.updateGenProgress(p); } cbs.onExecuted?.(nid, o); },
      onComplete: cbs.onComplete, onError: cbs.onError,
    });
  };

  // Close overlay — does NOT cancel generation. Use global bar to cancel.
  const handleClose = () => {
    if (wsRef.current && !generating) { wsRef.current.close(); wsRef.current = null; }
    onClose();
  };

  useEffect(() => {
    const handler = (e) => {
      if (e.key === 'Escape') handleClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [generating]);

  const handleWheel = (e) => { if (compResult) return; e.preventDefault(); setZoom(z => { const nz = Math.max(0.5, Math.min(5, z + (e.deltaY > 0 ? -0.15 : 0.15))); if (nz <= 1) setPan({ x: 0, y: 0 }); return nz; }); };
  const handleMouseDown = (e) => { if (zoom <= 1) return; e.preventDefault(); setDragging(true); dragStart.current = { x: e.clientX, y: e.clientY, panX: pan.x, panY: pan.y }; };
  const handleMouseMove = (e) => { if (!dragging) return; setPan({ x: dragStart.current.panX + (e.clientX - dragStart.current.x), y: dragStart.current.panY + (e.clientY - dragStart.current.y) }); };
  const handleMouseUp = () => setDragging(false);
  const resetView = () => { setZoom(1); setPan({ x: 0, y: 0 }); };

  // ── EDIT ──
  const handleEdit = useCallback(async () => {
    if (!editPrompt.trim()) return;
    setGenerating(true); setError(null); setCompResult(null); resetProgress();
    vs.startGeneration('studio', 'Studio: Editing...');
    await parkVlmIfLoaded();
    try {
      const mode = cfg.animatePreset || 'fast';
      const editPreset = ps.getSelectedPreset(mode, 'edit');

      const resp = await fetch(currentNode.preview); const blob = await resp.blob();
      const uploaded = await comfy.uploadImage(new File([blob], 'edit_src.png', { type: 'image/png' }));

      let wf;
      if (editPreset?.workflow === 'qwen_edit' || !editPreset) {
        // Use new Qwen Edit builder (or fallback to old editor overlay)
        const { buildEdit } = await import('../../lib/editWorkflow');
        wf = buildEdit({
          imageName: uploaded.name, editPrompt: editPrompt.trim(),
          negPrompt: editPreset?.negPrompt || '',
          resolution: meta?.resolution || 'square', highRes: cfg.animateHighRes || false,
          checkpoint: editPreset?.models?.checkpoint,
          clipModel: editPreset?.models?.clip, vaeModel: editPreset?.models?.vae,
          steps: editPreset?.settings?.steps, cfg: editPreset?.settings?.cfg,
          loras: (editPreset?.loras || []).map(l => ({ name: l.name, strength: l.strength ?? 1 })),
        });
      } else {
        // Fallback to old editor overlay
        wf = buildEditorOverlay({ imageName: uploaded.name, prompt: editPrompt.trim(), resolution: meta?.resolution || 'square' });
      }

      const captured = [];
      wsRef.current = smartConnect(wf, {
        onExecuted: (nid, o) => { if (o?.images) for (const img of o.images) captured.push(img); },
        onComplete: async () => {
          if (captured.length > 0) {
            safeSet(() => setCompResult({ comfy: captured[0], preview: comfy.getImageUrl(captured[0].filename, captured[0].subfolder || '', captured[0].type || 'temp') }));
          }
          safeSet(() => setGenerating(false)); vs.endGeneration('studio', 'Edit complete!', 'success');
        },
        onError: (err) => { safeSet(() => { setError(err?.message || 'Edit failed'); setGenerating(false); }); vs.endGeneration('studio', 'Edit failed', 'error'); },
      });
      await comfy.queuePrompt(wf);
    } catch (err) { setError(err.message); setGenerating(false); vs.endGeneration('studio', 'Edit failed', 'error'); }
  }, [editPrompt, currentNode, meta, cfg, ps]);

  // ── HIRES ──
  const handleHires = useCallback(async (promptOverride, negOverride) => {
    setGenerating(true); setError(null); setCompResult(null); resetProgress(); setActivePanel('hires');
    vs.startGeneration('studio', 'Studio: Enhancing...');
    await parkVlmIfLoaded();
    try {
      const mode = cfg.animatePreset || 'fast';
      const hfPreset = ps.getSelectedPreset(mode, 'hirefix');

      const resp = await fetch(currentNode.preview); const blob = await resp.blob();
      const uploaded = await comfy.uploadImage(new File([blob], 'hires_src.png', { type: 'image/png' }));

      const prompt = promptOverride ?? 'add details and improvements to the image without changing the overall style, concept and idea.';
      const neg = negOverride ?? hfPreset?.negPrompt ?? '';
      const denoise = hfPreset?.settings?.denoise ?? 0.5;
      const upscaleBy = hfPreset?.settings?.upscaleBy ?? 1.5;
      const upscaleModel = hfPreset?.settings?.upscaleModel;
      const loras = (hfPreset?.loras || []).map(l => ({ name: l.name, strength: l.strength ?? 1 }));

      let wf;
      if (hfPreset?.workflow === 'sdxl_hirefix') {
        // SDXL HireFix — pull model/CFG/prompts from image metadata
        // Fallback: backup T2I preset for checkpoint + CFG (NOT steps)
        const backupT2i = hfPreset?.backupPreset ? ps.presets.find(p => p.id === hfPreset.backupPreset) : null;
        const { buildHirefixSdxl } = await import('../../lib/editWorkflow');
        wf = buildHirefixSdxl({
          imageName: uploaded.name,
          checkpoint: meta?.checkpoint || backupT2i?.models?.checkpoint,
          positivePrompt: meta?.prompt || prompt,
          negPrompt: meta?.negPrompt || backupT2i?.negPrompt || neg,
          steps: hfPreset?.settings?.steps,
          cfg: meta?.cfg || backupT2i?.settings?.cfg || 7,
          denoise, upscaleBy, upscaleModel, loras,
        });
      } else {
        // Qwen HireFix (default)
        const { buildHirefixQwen } = await import('../../lib/editWorkflow');
        wf = buildHirefixQwen({
          imageName: uploaded.name,
          editPrompt: prompt, negPrompt: neg,
          checkpoint: hfPreset?.models?.checkpoint,
          clipModel: hfPreset?.models?.clip, vaeModel: hfPreset?.models?.vae,
          steps: hfPreset?.settings?.steps, cfg: hfPreset?.settings?.cfg,
          denoise, upscaleBy, upscaleModel, loras,
        });
      }

      const captured = [];
      wsRef.current = smartConnect(wf, {
        onExecuted: (nid, o) => { if (o?.images) for (const img of o.images) captured.push(img); },
        onComplete: async () => {
          if (captured.length > 0) {
            safeSet(() => setCompResult({ comfy: captured[0], preview: comfy.getImageUrl(captured[0].filename, captured[0].subfolder || '', captured[0].type || 'temp') }));
          }
          safeSet(() => setGenerating(false)); vs.endGeneration('studio', 'Hires complete!', 'success');
        },
        onError: (err) => { safeSet(() => { setError(err?.message || 'Hires failed'); setGenerating(false); }); vs.endGeneration('studio', 'Hires failed', 'error'); },
      });
      await comfy.queuePrompt(wf);
    } catch (err) { setError(err.message); setGenerating(false); vs.endGeneration('studio', 'Hires failed', 'error'); }
  }, [currentNode, cfg, meta, ps]);

  // ── Keep Both / Replace (for edit or hires) ──
  const handleKeepBoth = useCallback(async (type) => {
    if (!compResult?.comfy || !window.electronAPI) return;
    try {
      const sourceInfo = { sourceNode: selectedNode, sourcePrompt: meta?.prompt || '', sourceSeed: meta?.seed, sourceSize: meta?.width ? `${meta.width}×${meta.height}` : '' };
      const mode = cfg.animatePreset || 'fast';
      const genSettings = type === 'edit'
        ? { editPrompt: editPrompt.trim(), preset: ps.getSelectedPreset(mode, 'edit')?.name, ...sourceInfo }
        : { preset: ps.getSelectedPreset(mode, 'hirefix')?.name, ...sourceInfo };
      const updated = await window.electronAPI.pkgAddVariant({
        sessionId, pkgId: pkg.id, type,
        comfyFilename: compResult.comfy.filename, comfySubfolder: compResult.comfy.subfolder || '', comfyType: compResult.comfy.type || 'temp',
        settings: genSettings,
      });
      setCompResult(null); setActivePanel(null);
      onPkgUpdated?.(updated.pkg);
    } catch (err) { setError(err.message); }
  }, [compResult, sessionId, pkg, editPrompt, cfg, selectedNode, meta, ps]);

  const handleReplace = useCallback(async () => {
    if (!compResult?.comfy || !window.electronAPI) return;
    try {
      const updated = await window.electronAPI.pkgReplaceImage({
        sessionId, pkgId: pkg.id, nodeId: selectedNode,
        comfyFilename: compResult.comfy.filename, comfySubfolder: compResult.comfy.subfolder || '', comfyType: compResult.comfy.type || 'temp',
      });
      setCompResult(null); setActivePanel(null);
      onPkgUpdated?.(updated);
    } catch (err) { setError(err.message); }
  }, [compResult, sessionId, pkg, selectedNode]);

  // ── ANIMATE ──
  const handleVideoGenerate = useCallback(async (finalPrompt, promptInfo = {}) => {
    setGenerating(true); setError(null); setVideoUrl(null); setVlmPhase('comfyui'); resetProgress();
    vs.startGeneration('studio', 'Studio: Animating...');
    await parkVlmIfLoaded();
    try {
      const resp = await fetch(currentNode.preview); const blob = await resp.blob();
      const uploaded = await comfy.uploadImage(new File([blob], 'anim_src.png', { type: 'image/png' }));

      // Resolve video preset from preset store
      const mode = cfg.animatePreset || 'fast';
      const videoPreset = ps.getSelectedPreset(mode, 'video');
      if (!videoPreset) throw new Error(`No video preset for ${mode} mode. Set one in Presets tab.`);

      // Session folder for SaveVideoChunk fallback
      const sessionPath = await window.electronAPI?.getSessionPath?.(sessionId);
      const videoFileName = `anim_${Date.now()}`;
      const dirSessionId = `studio_${videoFileName}`;

      const wf = buildI2V({
        imageName: uploaded.name, userPrompt: finalPrompt,
        projectPath: sessionPath || '', fileName: videoFileName,
        latentPrefix: `latents/${dirSessionId}`,
        qualityPreset: mode, settings: videoPreset.settings,
        resolution: meta?.resolution || 'portrait', highRes: cfg.animateHighRes,
        ckptHigh: videoPreset.models?.ckptHigh, ckptLow: videoPreset.models?.ckptLow,
        clipModel: videoPreset.models?.clip, vaeModel: videoPreset.models?.vae,
        fps: 16, videoDuration: 5,
        lorasHigh: (videoPreset.loras || []).filter(l => l.nameHigh).map(l => ({ name: l.nameHigh, strength: l.strengthHigh ?? 1 })),
        lorasLow: (videoPreset.loras || []).filter(l => l.nameLow).map(l => ({ name: l.nameLow, strength: l.strengthLow ?? 1 })),
      });

      let capturedVideo = null;
      wsRef.current = smartConnect(wf, {
        // Try capturing from CreateVideo or any standard video output node
        onExecuted: (nid, o) => {
          if (!o || capturedVideo) return;
          const v = o.gifs?.[0] || o.videos?.[0] || o.images?.find(f => f.filename?.match(/\.(mp4|webm|mov|gif)$/i));
          if (v) capturedVideo = v;
        },
        onComplete: async () => {
          try {
            if (capturedVideo) {
              // Standard WebSocket capture worked (CreateVideo node)
              const url = comfy.getVideoUrl(capturedVideo.filename, capturedVideo.subfolder || 'video', capturedVideo.type || 'output');
              safeSet(() => setVideoUrl(url));
              if (window.electronAPI) {
                const updated = await window.electronAPI.pkgAddVideo({
                  sessionId, pkgId: pkg.id, nodeId: selectedNode,
                  comfyFilename: capturedVideo.filename, comfySubfolder: capturedVideo.subfolder || 'video', comfyType: capturedVideo.type || 'output',
                  videoMeta: { finalPrompt, userPrompt: promptInfo.userPrompt || '', vlmPrompt: promptInfo.vlmPrompt || '', vlmMode: promptInfo.vlmMode || 'off', preset: cfg.animatePreset, source: 'studio' },
                });
                if (mountedRef.current) onPkgUpdated?.(updated);
              }
            } else {
              // Fallback: find video from SaveVideoChunk in session folder
              const videoInfo = await window.electronAPI?.findLatestVideo?.(sessionPath, videoFileName);
              if (videoInfo?.ok) {
                const pushed = await window.electronAPI?.copyFileToComfyInput?.(videoInfo.path, `${videoFileName}.mp4`);
                if (pushed?.ok) {
                  safeSet(() => setVideoUrl(comfy.getVideoUrl(pushed.name, '', 'input')));
                  if (window.electronAPI) {
                    const updated = await window.electronAPI.pkgAddVideo({
                      sessionId, pkgId: pkg.id, nodeId: selectedNode, localPath: videoInfo.path,
                      videoMeta: { finalPrompt, userPrompt: promptInfo.userPrompt || '', vlmPrompt: promptInfo.vlmPrompt || '', vlmMode: promptInfo.vlmMode || 'off', preset: cfg.animatePreset, source: 'studio' },
                    });
                    if (mountedRef.current) onPkgUpdated?.(updated);
                  }
                } else { safeSet(() => setError('Could not serve video')); }
              } else { safeSet(() => setError('No video found after generation')); }
            }
          } catch (e) { safeSet(() => setError('Video capture: ' + e.message)); }

          // Save to Director projects (video + latent pair for extending)
          try {
            if (window.electronAPI && capturedVideo) {
              await window.electronAPI.directorSaveVideo({
                sessionId: dirSessionId, comfyFilename: capturedVideo.filename,
                comfySubfolder: capturedVideo.subfolder || 'video', comfyType: capturedVideo.type || 'output',
              });
              await window.electronAPI.directorGrabLatent({ sessionId: dirSessionId, prefix: dirSessionId });
              await window.electronAPI.directorSaveProject({ sessionId: dirSessionId, metadata: {
                engine: 'wan22',
                intent: finalPrompt, resolution: meta?.resolution || 'portrait',
                videoPreset: mode, targetLength: 5, completedSegments: 1,
                hasImage: true, hasVideo: true, source: 'studio',
                createdAt: Date.now(), updatedAt: Date.now(),
              }});
            }
          } catch {}

          safeSet(() => { setGenerating(false); setVlmPhase('idle'); });
          vs.endGeneration('studio', 'Animation complete!', 'success');
        },
        onError: (err) => { safeSet(() => { setError(err?.message || 'Animate failed'); setGenerating(false); setVlmPhase('idle'); }); vs.endGeneration('studio', 'Animation failed', 'error'); },
      });
      await comfy.queuePrompt(wf);
    } catch (err) { setError(err.message); setGenerating(false); setVlmPhase('idle'); vs.endGeneration('studio', 'Animation failed', 'error'); }
  }, [currentNode, selectedNode, sessionId, pkg, cfg, vs, meta, ps]);

  const handleVlmGenerate = useCallback(async (userGuidance) => {
    setError(null); setVlmPhase('vlm'); setVlmPrompt('');
    try {
      const vlmCfg = ps.getVlmConfig();
      if (!vlmCfg.enabled) throw new Error('No VLM preset selected. Set one in the header bar.');

      const resp = await fetch(currentNode.preview); const blob = await resp.blob();
      const imageBase64 = await new Promise(r => { const rd = new FileReader(); rd.onload = () => r(rd.result.split(',')[1]); rd.readAsDataURL(blob); });

      const { runTool } = await import('../../lib/vlm-tools');
      const result = await runTool('imageToVideo', {
        imageBase64,
        mode: animVlmMode === 'auto' ? 'auto' : 'guided',
        userGuidance,
        originalPrompt: meta?.prompt || '',
        onStatus: s => setVlmStatus(s),
      }, vlmCfg, { afterInference: vs.vlmAfterInference || 'park', pythonPath: vs.pythonPath || 'python' });

      setVlmPrompt(result.prompt);
      if (cfg.vlmAutoAnimate) {
        handleVideoGenerate(result.prompt, { vlmPrompt: result.prompt, userGuidance: userGuidance || '', vlmMode: animVlmMode });
      } else {
        setVlmPhase('preview');
      }
    } catch (err) { setError(err.message); setVlmPhase('idle'); }
  }, [currentNode, meta, animVlmMode, vs, cfg.vlmAutoAnimate, handleVideoGenerate, ps]);

  const handleAnimate = useCallback((prompt) => {
    if (animVlmMode === 'guided') handleVlmGenerate(prompt);
    else if (animVlmMode === 'auto') handleVlmGenerate();
    else handleVideoGenerate(prompt || animPrompt, { userPrompt: prompt || animPrompt, vlmMode: 'off' });
  }, [animVlmMode, handleVlmGenerate, handleVideoGenerate, animPrompt]);

  // ── Save file ──
  const handleSave = async () => {
    if (!window.electronAPI) return;
    const target = videoUrl && currentVideo?.path ? { sourcePath: currentVideo.path, defaultName: currentVideo.filename, filters: [{ name: 'Video', extensions: ['mp4'] }] }
      : currentNode?.path ? { sourcePath: currentNode.path, defaultName: currentNode.filename, filters: [{ name: 'Image', extensions: ['png'] }] } : null;
    if (target) await window.electronAPI.saveFileAs(target);
  };

  // ── Delete node (unified — handles root and variants) ──
  const handleDeleteNode = async (nodeId) => {
    if (!window.electronAPI) return;
    if (nodeId === 'root') {
      if ((pkg.variants || []).length > 0) {
        // Promote next variant to root (merge metadata)
        const updated = await window.electronAPI.pkgPromoteVariant({ sessionId, pkgId: pkg.id });
        setSelectedNode('root');
        onPkgUpdated?.(updated);
      } else {
        // No variants — delete entire package
        await window.electronAPI.pkgDelete({ sessionId, pkgId: pkg.id });
        onPkgDeleted?.(pkg.id);
      }
    } else {
      // Delete variant
      const updated = await window.electronAPI.pkgDeleteVariant({ sessionId, pkgId: pkg.id, variantId: nodeId });
      setSelectedNode('root');
      onPkgUpdated?.(updated);
    }
  };

  // ── Delete video from current node ──
  const handleDeleteVideo = async (videoFilename) => {
    if (!window.electronAPI) return;
    const updated = await window.electronAPI.pkgDeleteVideo({ sessionId, pkgId: pkg.id, nodeId: selectedNode, videoFilename });
    setShowVideo(false); setVideoIdx(0);
    onPkgUpdated?.(updated);
  };

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center no-drag" style={{ WebkitAppRegion: 'no-drag' }}>
      <div className="absolute inset-0 bg-black/80 backdrop-blur-sm" onClick={handleClose} />
      <style>{`@keyframes shimmerSweep{0%{transform:translateX(-100%)}100%{transform:translateX(100%)}}`}</style>

      <div className="relative flex w-[92%] h-[88%] max-w-[1400px] rounded-xl overflow-hidden border border-surface-border shadow-2xl bg-bg-900">

        {/* ═══ LEFT: Visual ═══ */}
        <div className="flex-1 flex flex-col min-w-0 relative">
          {generating && pp > 0 && <div className="absolute top-0 left-0 right-0 h-1 bg-bg-700 z-10"><div className="h-full bg-accent rounded-r-full transition-all duration-300" style={{ width: `${Math.round(pp * 100)}%` }} /></div>}

          <div className="flex-1 flex items-center justify-center overflow-hidden p-4" onWheel={handleWheel}
            onMouseDown={handleMouseDown} onMouseMove={handleMouseMove} onMouseUp={handleMouseUp} onMouseLeave={handleMouseUp}
            style={{ cursor: zoom > 1 ? (dragging ? 'grabbing' : 'grab') : 'default' }}>
            {compResult && !generating ? (
              <div className="w-full h-full"><CompareSlider originalSrc={currentNode?.preview} resultSrc={compResult.preview} label={activePanel === 'edit' ? 'Edited' : 'Hires'} /></div>
            ) : videoUrl && !generating ? (
              <video src={videoUrl} className="max-h-full max-w-full rounded-lg border border-surface-border transition-transform duration-150" style={{ transform: `scale(${zoom}) translate(${pan.x / zoom}px, ${pan.y / zoom}px)` }} autoPlay loop muted onDoubleClick={resetView} />
            ) : showVideo && currentVideo ? (
              <video key={currentVideo.path} src={currentVideo.videoUrl || `file:///${currentVideo.path?.replace(/\\/g, '/')}`} className="max-h-full max-w-full rounded-lg transition-transform duration-150" style={{ transform: `scale(${zoom}) translate(${pan.x / zoom}px, ${pan.y / zoom}px)` }} autoPlay loop muted onDoubleClick={resetView} />
            ) : generating ? (
              <div className="relative rounded-lg overflow-hidden">
                <img src={currentNode?.preview} className="max-h-[70vh] max-w-full block" style={{ filter: `blur(${Math.max(0, 12 * (1 - pp))}px) brightness(${0.3 + 0.7 * pp})`, transition: 'filter 0.5s ease-out' }} />
                <div className="absolute inset-0 overflow-hidden pointer-events-none"><div className="absolute inset-0" style={{ background: 'linear-gradient(105deg, transparent 40%, rgba(124,58,237,0.15) 50%, transparent 60%)', animation: 'shimmerSweep 2s ease-in-out infinite' }} /></div>
                <div className="absolute bottom-3 left-1/2 -translate-x-1/2 bg-black/60 backdrop-blur-sm rounded-full px-3 py-1 flex items-center gap-2">
                  <Loader2 size={12} className="animate-spin text-accent" />
                  <span className="text-[11px] text-accent font-mono">{vlmPhase === 'vlm' ? vlmStatus : pp > 0 ? `${Math.round(pp * 100)}%` : 'Preparing...'}</span>
                </div>
              </div>
            ) : (
              <img src={currentNode?.preview} className="max-h-full max-w-full object-contain rounded transition-transform duration-150" style={{ transform: `scale(${zoom}) translate(${pan.x / zoom}px, ${pan.y / zoom}px)`, cursor: zoom > 1 ? (dragging ? 'grabbing' : 'grab') : 'zoom-in' }} onDoubleClick={resetView} />
            )}
          </div>

          {/* Bottom bar */}
          <div className="flex items-center justify-between px-4 py-2 bg-bg-800/80 border-t border-surface-border shrink-0">
            <div className="flex items-center gap-2">
              {nodeVideos.length > 0 && (
                <div className="flex items-center gap-1 bg-bg-700 rounded-full px-1 py-0.5">
                  <button onClick={() => setShowVideo(false)} className={`text-[10px] px-2 py-0.5 rounded-full ${!showVideo ? 'bg-accent text-white' : 'text-neutral-500'}`}>Image</button>
                  <button onClick={() => { setShowVideo(true); setVideoIdx(nodeVideos.length - 1); }} className={`text-[10px] px-2 py-0.5 rounded-full flex items-center gap-1 ${showVideo ? 'bg-emerald-500 text-white' : 'text-neutral-500'}`}>
                    <Film size={9} /> {nodeVideos.length > 1 ? `${videoIdx + 1}/${nodeVideos.length}` : 'Video'}
                  </button>
                  {nodeVideos.length > 1 && showVideo && <>
                    <button onClick={() => setVideoIdx(Math.max(0, videoIdx - 1))} disabled={videoIdx <= 0} className="text-[10px] px-1 text-neutral-400 disabled:opacity-30">◀</button>
                    <button onClick={() => setVideoIdx(Math.min(nodeVideos.length - 1, videoIdx + 1))} disabled={videoIdx >= nodeVideos.length - 1} className="text-[10px] px-1 text-neutral-400 disabled:opacity-30">▶</button>
                  </>}
                </div>
              )}
              {!compResult && (
                <div className="flex items-center gap-1">
                  <button onClick={() => setZoom(z => Math.min(5, z + 0.25))} className="text-neutral-600 hover:text-neutral-400 p-1"><ZoomIn size={14} /></button>
                  <span className="text-[9px] text-neutral-600 w-8 text-center">{Math.round(zoom * 100)}%</span>
                  <button onClick={() => setZoom(z => { const nz = Math.max(0.5, z - 0.25); if (nz <= 1) setPan({ x: 0, y: 0 }); return nz; })} className="text-neutral-600 hover:text-neutral-400 p-1"><ZoomOut size={14} /></button>
                  {zoom !== 1 && <button onClick={resetView} className="text-neutral-600 hover:text-neutral-400 p-1"><RotateCcw size={12} /></button>}
                </div>
              )}
            </div>
            <div className="flex items-center gap-2">
              <button onClick={handleSave} className="btn btn-ghost text-[10px] px-2 py-1 border border-surface-border flex items-center gap-1"><Download size={11} /> Save</button>
            </div>
          </div>
        </div>

        {/* ═══ RIGHT: Package Tree + Details ═══ */}
        <div className="w-80 shrink-0 flex flex-col border-l border-surface-border bg-bg-800 overflow-hidden">
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-2.5 border-b border-surface-border shrink-0">
            <span className="text-[11px] text-neutral-400 truncate flex-1">Package</span>
            <button onClick={handleClose} className="text-neutral-500 hover:text-white ml-2"><X size={16} /></button>
          </div>

          <div className="flex-1 overflow-y-auto">
            {/* ── Package Tree ── */}
            <div className="p-3 border-b border-surface-border">
              <span className="text-[9px] text-neutral-600 uppercase tracking-wider block mb-2">Lineage</span>
              {/* Root */}
              <div className="flex items-center gap-0.5">
                <button onClick={() => { setSelectedNode('root'); setShowVideo(false); setVideoIdx(0); setCompResult(null); setVideoUrl(null); }}
                  className={`flex-1 text-left text-[10px] px-2 py-1.5 rounded flex items-center gap-2 ${selectedNode === 'root' ? 'bg-accent/10 text-accent border border-accent/30' : 'text-neutral-400 hover:bg-bg-700'}`}>
                  <ImageIcon size={10} /> <span className="flex-1 truncate">Original</span>
                  {pkg.root?.videos?.length > 0 && <span className="text-[8px] text-emerald-400">▶{pkg.root.videos.length}</span>}
                </button>
                {!generating && (
                  <button onClick={(e) => { e.stopPropagation();
                    const hasVariants = (pkg.variants || []).length > 0;
                    const msg = hasVariants ? 'Delete original? The next variant will become the new root.' : 'Delete this image? (no variants — package will be removed)';
                    if (cfg.skipDeleteConfirm) { handleDeleteNode('root'); } else if (confirm(msg)) { handleDeleteNode('root'); }
                  }} className="text-neutral-700 hover:text-red-400 p-0.5 shrink-0"><Trash2 size={9} /></button>
                )}
              </div>
              {/* Variants */}
              {(pkg.variants || []).map(v => (
                <div key={v.id} className="flex items-center gap-0.5 ml-3">
                  <span className="text-neutral-700 text-[10px]">├</span>
                  <button onClick={() => { setSelectedNode(v.id); setShowVideo(false); setVideoIdx(0); setCompResult(null); setVideoUrl(null); }}
                    className={`flex-1 text-left text-[10px] px-2 py-1 rounded flex items-center gap-1.5 ${selectedNode === v.id ? 'bg-accent/10 text-accent border border-accent/30' : 'text-neutral-500 hover:bg-bg-700'}`}>
                    {v.type === 'hires' ? <Sparkles size={9} /> : <Pencil size={9} />}
                    <span className="flex-1 truncate">{v.label}</span>
                    {v.videos?.length > 0 && <span className="text-[8px] text-emerald-400">▶{v.videos.length}</span>}
                  </button>
                  {!generating && (
                    <button onClick={(e) => { e.stopPropagation();
                      if (cfg.skipDeleteConfirm) { handleDeleteNode(v.id); } else if (confirm(`Delete "${v.label}"?`)) { handleDeleteNode(v.id); }
                    }} className="text-neutral-700 hover:text-red-400 p-0.5 shrink-0"><Trash2 size={9} /></button>
                  )}
                </div>
              ))}
            </div>

            {/* ── Node Details ── */}
            <div className="p-4 border-b border-surface-border space-y-3">
              {/* Source Image Details */}
              <div className="space-y-1.5">
                <span className="text-[9px] text-neutral-600 uppercase tracking-wider">
                  {selectedNode === 'root' ? '🖼 Image Details' : '🖼 Source Image'}
                </span>
                {(selectedNode === 'root' ? meta?.prompt : (currentNode?.settings?.sourcePrompt || meta?.prompt)) && (
                  <div>
                    <div className="flex items-center justify-between mb-0.5">
                      <span className="text-[9px] text-neutral-600">Prompt</span>
                      <button onClick={() => copyText(selectedNode === 'root' ? meta.prompt : (currentNode?.settings?.sourcePrompt || meta?.prompt), 'prompt')} className="text-neutral-600 hover:text-neutral-400">{copied === 'prompt' ? <Check size={10} className="text-green-400" /> : <Copy size={10} />}</button>
                    </div>
                    <p className="text-[10px] text-neutral-300 leading-relaxed line-clamp-3">{selectedNode === 'root' ? meta?.prompt : (currentNode?.settings?.sourcePrompt || meta?.prompt)}</p>
                  </div>
                )}
                <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[10px]">
                  {meta?.width && <><span className="text-neutral-600">Size</span><span className="text-neutral-400">{meta.width}×{meta.height}</span></>}
                  {meta?.seed > 0 && <><span className="text-neutral-600">Seed</span><span className="text-neutral-400 cursor-pointer hover:text-accent" onClick={() => copyText(String(meta.seed), 'seed')}>{meta.seed}{copied === 'seed' ? ' ✓' : ''}</span></>}
                  {meta?.steps && <><span className="text-neutral-600">Steps</span><span className="text-neutral-400">{meta.steps}</span></>}
                  {meta?.cfg && <><span className="text-neutral-600">CFG</span><span className="text-neutral-400">{meta.cfg}</span></>}
                  {meta?.checkpoint && <><span className="text-neutral-600">Model</span><span className="text-neutral-400 truncate" title={meta.checkpoint}>{meta.checkpoint.split(/[/\\]/).pop()}</span></>}
                </div>
              </div>

              {/* Generation Details (for variants) */}
              {selectedNode !== 'root' && currentNode?.settings && (
                <div className="space-y-1.5 pt-2 border-t border-surface-border/50">
                  <span className="text-[9px] uppercase tracking-wider" style={{ color: currentNode.type === 'edit' ? '#c084fc' : '#818cf8' }}>
                    {currentNode.type === 'edit' ? '✏️ Edit Details' : '✨ Hires Details'}
                  </span>
                  {currentNode.settings?.editPrompt && (
                    <div>
                      <span className="text-[9px] text-neutral-600">Edit Prompt</span>
                      <p className="text-[10px] text-purple-300 bg-purple-500/10 rounded p-1.5 mt-0.5">{currentNode.settings.editPrompt}</p>
                    </div>
                  )}
                  {currentNode.type === 'hires' && (
                    <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[10px]">
                      {currentNode.settings?.mode && <><span className="text-neutral-600">Mode</span><span className="text-neutral-400">{currentNode.settings.mode === 'fast' ? '⚡ Fast' : '🎨 Quality'}</span></>}
                      {currentNode.settings?.denoise != null && <><span className="text-neutral-600">Denoise</span><span className="text-neutral-400">{currentNode.settings.denoise}</span></>}
                      {currentNode.settings?.upscaleBy && <><span className="text-neutral-600">Upscale</span><span className="text-neutral-400">{currentNode.settings.upscaleBy}×</span></>}
                      {currentNode.settings?.upscaleModel && <><span className="text-neutral-600">Upscaler</span><span className="text-neutral-400 truncate" title={currentNode.settings.upscaleModel}>{currentNode.settings.upscaleModel.split(/[/\\]/).pop()}</span></>}
                    </div>
                  )}
                </div>
              )}

              {/* Video Details (when viewing a video) */}
              {showVideo && currentVideo && (
                <div className="space-y-1.5 pt-2 border-t border-surface-border/50">
                  <span className="text-[9px] text-emerald-400 uppercase tracking-wider">🎬 Video Details</span>
                  {currentVideo.vlmMode && currentVideo.vlmMode !== 'off' && currentVideo.vlmPrompt && (
                    <div>
                      <div className="flex items-center justify-between mb-0.5">
                        <span className="text-[9px] text-neutral-600">VLM Prompt</span>
                        <button onClick={() => copyText(currentVideo.vlmPrompt, 'vlm')} className="text-neutral-600 hover:text-neutral-400">{copied === 'vlm' ? <Check size={10} className="text-green-400" /> : <Copy size={10} />}</button>
                      </div>
                      <p className="text-[10px] text-emerald-300 bg-emerald-500/10 rounded p-1.5 line-clamp-4">{currentVideo.vlmPrompt}</p>
                    </div>
                  )}
                  {currentVideo.userPrompt && (
                    <div>
                      <span className="text-[9px] text-neutral-600">User Prompt</span>
                      <p className="text-[10px] text-neutral-300 bg-bg-700 rounded p-1.5 mt-0.5">{currentVideo.userPrompt}</p>
                    </div>
                  )}
                  {currentVideo.finalPrompt && !currentVideo.vlmPrompt && !currentVideo.userPrompt && (
                    <div>
                      <div className="flex items-center justify-between mb-0.5">
                        <span className="text-[9px] text-neutral-600">Prompt</span>
                        <button onClick={() => copyText(currentVideo.finalPrompt, 'fp')} className="text-neutral-600 hover:text-neutral-400">{copied === 'fp' ? <Check size={10} className="text-green-400" /> : <Copy size={10} />}</button>
                      </div>
                      <p className="text-[10px] text-neutral-300 bg-bg-700 rounded p-1.5">{currentVideo.finalPrompt}</p>
                    </div>
                  )}
                  <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[10px]">
                    {currentVideo.mode && <><span className="text-neutral-600">Engine</span><span className="text-neutral-400">{currentVideo.mode === 'ltx23' ? 'LTX 2.3' : 'Wan 2.2'}</span></>}
                    {currentVideo.preset && <><span className="text-neutral-600">Preset</span><span className="text-neutral-400">{currentVideo.preset === 'fast' ? '⚡ Fast' : '🎨 Quality'}</span></>}
                    {currentVideo.vlmMode && <><span className="text-neutral-600">VLM</span><span className="text-neutral-400">{currentVideo.vlmMode === 'off' ? 'Off' : currentVideo.vlmMode === 'guided' ? 'Guided' : 'Auto'}</span></>}
                    {currentVideo.source && <><span className="text-neutral-600">Source</span><span className="text-neutral-400">{currentVideo.source}</span></>}
                  </div>
                </div>
              )}
            </div>

            {/* ── Videos for this node ── */}
            {nodeVideos.length > 0 && (
              <div className="px-3 py-2 border-b border-surface-border">
                <span className="text-[9px] text-neutral-600 uppercase tracking-wider block mb-1.5">Videos ({nodeVideos.length})</span>
                <div className="space-y-0.5">
                  {nodeVideos.map((v, i) => (
                    <div key={v.filename} className={`flex items-center gap-1.5 text-[10px] px-2 py-1 rounded ${showVideo && videoIdx === i ? 'bg-emerald-500/10 text-emerald-400' : 'text-neutral-500 hover:bg-bg-700'}`}>
                      <button onClick={() => { setShowVideo(true); setVideoIdx(i); }} className="flex-1 flex items-center gap-1.5 truncate text-left">
                        <Film size={9} className="shrink-0" />
                        <span className="truncate">{v.filename}</span>
                      </button>
                      <span className="text-[8px] text-neutral-700 shrink-0">{v.mode === 'ltx23' ? 'LTX' : v.mode === 'wan22' ? 'Wan' : ''}</span>
                      {!generating && (
                        <button onClick={(e) => { e.stopPropagation(); if (confirm('Delete this video?')) handleDeleteVideo(v.filename); }}
                          className="text-neutral-700 hover:text-red-400 shrink-0 p-0.5"><Trash2 size={9} /></button>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* ── Action Buttons ── */}
            <div className="px-4 py-3 border-b border-surface-border">
              <div className="flex gap-1">
                <button disabled={generating} onClick={() => setActivePanel(activePanel === 'edit' ? null : 'edit')}
                  className={`flex-1 text-[10px] py-2 rounded flex items-center justify-center gap-1 transition-colors disabled:opacity-30 ${activePanel === 'edit' ? 'bg-purple-600 text-white' : 'btn-ghost text-neutral-500'}`}>
                  <Pencil size={11} /> Edit
                </button>
                <button disabled={generating} onClick={() => setActivePanel(activePanel === 'hires' ? null : 'hires')}
                  className={`flex-1 text-[10px] py-2 rounded flex items-center justify-center gap-1 transition-colors disabled:opacity-30 ${activePanel === 'hires' ? 'bg-accent text-white' : 'btn-ghost text-neutral-500'}`}>
                  <Sparkles size={11} /> Hires
                </button>
                <button disabled={generating} onClick={() => setActivePanel(activePanel === 'animate' ? null : 'animate')}
                  className={`flex-1 text-[10px] py-2 rounded flex items-center justify-center gap-1 transition-colors disabled:opacity-30 ${activePanel === 'animate' ? 'bg-emerald-600 text-white' : 'btn-ghost text-neutral-500'}`}>
                  <Film size={11} /> Animate
                </button>
              </div>
            </div>

            {/* ── EDIT Panel ── */}
            {activePanel === 'edit' && !generating && (
              <div className="px-4 py-3 border-b border-surface-border space-y-2">
                <span className="text-[10px] font-semibold text-purple-400 uppercase tracking-wider">Quick Edit</span>
                <textarea value={editPrompt} onChange={(e) => setEditPrompt(e.target.value)} placeholder='e.g. "make her hair red"' rows={3} className="input-field text-[10px] resize-none w-full" autoFocus onKeyDown={(e) => { if (e.key === 'Enter' && e.ctrlKey && editPrompt.trim()) handleEdit(); }} />
                <button onClick={handleEdit} disabled={!editPrompt.trim()} className="btn btn-accent text-[10px] w-full flex items-center justify-center gap-1 disabled:opacity-40"><Play size={11} /> Edit Image</button>
                {compResult && (
                  <div className="space-y-1 pt-2 border-t border-surface-border">
                    <p className="text-[9px] text-neutral-500">Drag slider to compare.</p>
                    <div className="flex gap-1">
                      <button onClick={handleReplace} className="flex-1 btn btn-ghost text-[9px] py-1.5 border border-surface-border">Replace</button>
                      <button onClick={() => handleKeepBoth('edit')} className="flex-1 btn btn-ghost text-[9px] py-1.5 border border-surface-border">Keep Both</button>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* ── HIRES Panel ── */}
            {activePanel === 'hires' && (() => {
              const mode = cfg.animatePreset || 'fast';
              const hfPreset = ps.getSelectedPreset(mode, 'hirefix');
              const isSDXL = hfPreset?.workflow === 'sdxl_hirefix';
              const isQuality = mode === 'quality';
              return (
              <div className="px-4 py-3 border-b border-surface-border space-y-2">
                <span className="text-[10px] font-semibold text-accent uppercase tracking-wider">
                  Hires Fix {isSDXL ? '(SDXL)' : '(Qwen)'}
                </span>
                {generating && <div className="flex items-center gap-2 bg-accent/10 border border-accent/20 rounded-lg p-2.5"><Loader2 size={14} className="animate-spin text-accent" /><div className="flex-1"><p className="text-[10px] text-accent">Enhancing...</p><div className="w-full h-1 bg-bg-900 rounded-full mt-1 overflow-hidden"><div className="h-full bg-accent rounded-full transition-all" style={{ width: `${Math.round(pp * 100)}%` }} /></div></div></div>}
                {!generating && compResult && (
                  <div className="space-y-2">
                    <p className="text-[9px] text-neutral-500">Drag slider to compare.</p>
                    <div className="flex gap-1">
                      <button onClick={handleReplace} className="flex-1 btn btn-ghost text-[9px] py-1.5 border border-surface-border">Replace</button>
                      <button onClick={() => handleKeepBoth('hires')} className="flex-1 btn btn-ghost text-[9px] py-1.5 border border-surface-border">Keep Both</button>
                    </div>
                    <button onClick={() => setCompResult(null)} className="w-full text-[9px] text-neutral-600 hover:text-neutral-400">Run again</button>
                  </div>
                )}
                {!generating && !compResult && isSDXL && (
                  <div className="space-y-2">
                    <p className="text-[9px] text-neutral-500">Uses original image model, CFG, and prompts from metadata.</p>
                    <button onClick={() => handleHires()} className="btn btn-accent text-[10px] w-full flex items-center justify-center gap-1"><Sparkles size={11} /> Enhance</button>
                  </div>
                )}
                {!generating && !compResult && !isSDXL && (
                  <>
                    <div className="flex gap-1">
                      <button onClick={() => setHiresPromptMode('auto')} className={`flex-1 text-[10px] py-1.5 rounded font-medium ${hiresPromptMode === 'auto' ? 'bg-accent text-white' : 'btn-ghost'}`}>Auto</button>
                      <button onClick={() => setHiresPromptMode('manual')} className={`flex-1 text-[10px] py-1.5 rounded font-medium ${hiresPromptMode === 'manual' ? 'bg-accent text-white' : 'btn-ghost'}`}>Manual</button>
                    </div>
                    {hiresPromptMode === 'auto' ? (
                      <div className="space-y-2">
                        <div className="bg-bg-700/50 rounded p-2"><p className="text-[9px] text-neutral-400 italic">"add details and improvements without changing style, concept and idea."</p></div>
                        <button onClick={() => handleHires('add details and improvements to the image without changing the overall style, concept and idea.', '')} className="btn btn-accent text-[10px] w-full flex items-center justify-center gap-1"><Sparkles size={11} /> Enhance</button>
                      </div>
                    ) : (
                      <div className="space-y-2">
                        <textarea value={hiresManualPrompt} onChange={(e) => setHiresManualPrompt(e.target.value)} placeholder="Enhancement prompt..." rows={2} className="input-field text-[10px] resize-none w-full" />
                        {isQuality && (
                          <textarea value={hiresManualNeg} onChange={(e) => setHiresManualNeg(e.target.value)} placeholder="Negative prompt..." rows={2} className="input-field text-[10px] resize-none w-full opacity-70 focus:opacity-100" />
                        )}
                        {!isQuality && <p className="text-[8px] text-neutral-600">Negative prompt available in Quality mode only</p>}
                        <button onClick={() => handleHires(hiresManualPrompt || 'improve quality.', isQuality ? hiresManualNeg : '')} className="btn btn-accent text-[10px] w-full flex items-center justify-center gap-1"><Sparkles size={11} /> Enhance</button>
                      </div>
                    )}
                  </>
                )}
              </div>
              );
            })()}

            {/* ── ANIMATE Panel ── */}
            {activePanel === 'animate' && (
              <div className="px-4 py-3 border-b border-surface-border space-y-3">
                <span className="text-[10px] font-semibold text-emerald-400 uppercase tracking-wider">Animate</span>
                {vlmPhase === 'vlm' && <div className="flex items-center gap-2 bg-amber-500/10 border border-amber-500/20 rounded-lg p-2.5"><Loader2 size={14} className="animate-spin text-amber-400" /><div className="flex-1"><p className="text-[10px] text-amber-300">VLM Processing...</p><p className="text-[9px] text-amber-400/70 truncate">{vlmStatus}</p></div></div>}
                {generating && vlmPhase !== 'vlm' && <div className="flex items-center gap-2 bg-accent/10 border border-accent/20 rounded-lg p-2.5"><Loader2 size={14} className="animate-spin text-accent" /><div className="flex-1"><p className="text-[10px] text-accent">Generating Video...</p><div className="w-full h-1 bg-bg-900 rounded-full mt-1 overflow-hidden"><div className="h-full bg-accent rounded-full transition-all" style={{ width: `${Math.round(pp * 100)}%` }} /></div></div><span className="text-[9px] text-neutral-500">{Math.round(pp * 100)}%</span></div>}
                {/* VLM mode toggle */}
                {vlmPhase !== 'vlm' && !generating && (
                  <div className="flex gap-1">
                    {(() => { const vlmOn = ps.getVlmConfig().enabled; return ['off', 'guided', 'auto'].map(m => {
                      const disabled = m !== 'off' && !vlmOn;
                      return <button key={m} onClick={() => !disabled && setAnimVlmMode(m)} disabled={disabled}
                        className={`flex-1 text-[9px] py-1 rounded font-medium ${animVlmMode === m ? 'bg-accent text-white' : disabled ? 'btn-ghost opacity-30 cursor-not-allowed' : 'btn-ghost'}`}>
                        {m === 'off' ? 'Off' : m === 'guided' ? 'Guided' : 'Auto'}
                      </button>;
                    }); })()}
                  </div>
                )}
                {/* VLM preview — edit prompt before generating */}
                {vlmPhase === 'preview' && (
                  <div className="space-y-2">
                    <textarea value={vlmPrompt} onChange={(e) => setVlmPrompt(e.target.value)} rows={5} className="input-field text-[10px] resize-none w-full font-mono" onKeyDown={(e) => { if (e.key === 'Enter' && e.ctrlKey) handleVideoGenerate(vlmPrompt, { vlmPrompt, vlmMode: animVlmMode }); }} />
                    <div className="flex gap-1">
                      <button onClick={handleVlmGenerate} className="btn btn-ghost text-[9px] py-1.5 flex-1 border border-surface-border">Re-gen</button>
                      <button onClick={() => handleVideoGenerate(vlmPrompt, { vlmPrompt, vlmMode: animVlmMode })} className="btn btn-accent text-[9px] py-1.5 flex-1 flex items-center justify-center gap-1"><Film size={10} /> Generate</button>
                    </div>
                  </div>
                )}
                {/* Off mode — manual prompt */}
                {animVlmMode === 'off' && !generating && !videoUrl && vlmPhase === 'idle' && (
                  <div className="space-y-2">
                    <textarea value={animPrompt} onChange={(e) => setAnimPrompt(e.target.value)} placeholder="Video prompt..." rows={3} className="input-field text-[10px] resize-none w-full" />
                    <button onClick={() => handleAnimate(animPrompt)} disabled={!animPrompt.trim()} className="btn btn-accent text-[10px] w-full flex items-center justify-center gap-1 disabled:opacity-40"><Play size={11} /> Animate</button>
                  </div>
                )}
                {/* Guided mode — user tells VLM what they want */}
                {animVlmMode === 'guided' && vlmPhase === 'idle' && !generating && !videoUrl && (
                  <div className="space-y-2">
                    <textarea value={animPrompt} onChange={(e) => setAnimPrompt(e.target.value)} placeholder="Tell the VLM what you want... e.g. 'make her slowly turn and smile, gentle camera zoom in'" rows={3} className="input-field text-[10px] resize-none w-full" />
                    <button onClick={() => handleAnimate(animPrompt)} disabled={!animPrompt.trim()} className="btn btn-accent text-[10px] w-full flex items-center justify-center gap-1 disabled:opacity-40"><Play size={11} /> Generate with VLM</button>
                  </div>
                )}
                {/* Auto mode — full auto */}
                {animVlmMode === 'auto' && vlmPhase === 'idle' && !generating && !videoUrl && (
                  <div className="space-y-2">
                    <p className="text-[9px] text-neutral-500">VLM analyzes image → generates prompt → creates video automatically.</p>
                    <button onClick={() => handleAnimate('')} className="btn btn-accent text-[10px] w-full flex items-center justify-center gap-1"><Play size={11} /> Full Auto</button>
                  </div>
                )}
                {/* Video result actions */}
                {videoUrl && !generating && (
                  <div className="flex gap-1 pt-2 border-t border-surface-border">
                    <button onClick={() => { setVideoUrl(null); setVlmPhase('idle'); }} className="flex-1 btn btn-ghost text-[9px] py-1.5 border border-surface-border">New</button>
                  </div>
                )}
              </div>
            )}
          </div>

          {error && (
            <div className="mx-3 mb-2 bg-red-900/30 border border-red-800 rounded-md p-2 flex items-start gap-2 shrink-0">
              <span className="text-[10px] text-red-300 flex-1">{error}</span>
              <button onClick={() => setError(null)} className="text-red-400"><X size={12} /></button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
