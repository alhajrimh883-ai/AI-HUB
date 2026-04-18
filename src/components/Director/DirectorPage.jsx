import React, { useState, useCallback, useRef } from 'react';
import useDirectorStore, {
  DEFAULT_TEMPLATE_IMAGE, DEFAULT_TEMPLATE_I2V, DEFAULT_TEMPLATE_EXTEND,
  DEFAULT_TEMPLATE_PLAN, DEFAULT_TEMPLATE_PLAN_REVIEW, DEFAULT_TEMPLATE_LORA_SELECT,
} from '../../lib/directorStore';
import useStore from '../../lib/store';
import usePresetStore from '../../lib/presetStore';
import * as comfy from '../../lib/comfyui';
import { buildVideoToLatent } from '../../lib/sviproWorkflow';
import { runPipeline } from '../../lib/directorPipeline';
import {
  Play, Pause, Square, Upload, X, Film, Image as ImageIcon,
  ChevronDown, ChevronUp, RotateCcw, Check, Edit3,
  Loader, AlertCircle, Download,
} from 'lucide-react';

// ─── Component ───────────────────────────────────────────────────────

export default function DirectorPage() {
  const ds = useDirectorStore();
  const vs = useStore();
  const ps = usePresetStore();
  const wsRef = useRef(null);
  const vidInputRef = useRef(null);
  const imgInputRef = useRef(null);
  const [selectedSeg, setSelectedSeg] = useState(-1);
  const [showSettings, setShowSettings] = useState(false);
  const [showOptionals, setShowOptionals] = useState(false);
  const [showTemplates, setShowTemplates] = useState(false);
  const [showVlmHistory, setShowVlmHistory] = useState(false);
  const [showPrompts, setShowPrompts] = useState(false);
  const [showResumeGallery, setShowResumeGallery] = useState(false);
  const [resumeProjects, setResumeProjects] = useState([]);
  const [importVae, setImportVae] = useState('');
  const [importingVideo, setImportingVideo] = useState(false);

  const addLog = useCallback((src, msg) => { console.log(`[${src}] ${msg}`); }, []);

  const handleDirect = useCallback(async () => {
    if (!ds.userIntent) { ds.setError('Tell the VLM what you want to see'); return; }
    setSelectedSeg(-1);
    try { await runPipeline(ds, vs, wsRef, addLog); } catch (err) { ds.setError(typeof err === 'string' ? err : err?.message || JSON.stringify(err)); }
  }, [ds, vs, addLog]);

  const handlePause = useCallback(() => { ds.setPipelineState(ds.pipelineState === 'paused' ? 'running' : 'paused'); }, [ds]);
  const handleStop = useCallback(() => { comfy.interrupt(); ds.setPipelineState('idle'); ds.setPipelineStatus('Stopped'); if (wsRef.current) wsRef.current.close(); }, [ds]);
  const handleApprove = useCallback(() => { ds.setAwaitingApproval(false); }, [ds]);

  const handleImageUpload = useCallback(async (e) => {
    const file = e.target.files?.[0]; if (!file) return;
    try { const r = await comfy.uploadImage(file); ds.setInputImage({ name: r.name, preview: comfy.getImageUrl(r.name, '', 'input') }); ds.setInputVideo(null); } catch (err) { ds.setError(err.message); }
    e.target.value = '';
  }, [ds]);

  const handleVideoUpload = useCallback(async (e) => {
    const file = e.target.files?.[0]; if (!file) return;
    try { const r = await comfy.uploadVideo(file); ds.setInputVideo({ name: r.name, preview: comfy.getVideoUrl(r.name, '', 'input') }); ds.setInputImage(null); } catch (err) { ds.setError(err.message); }
    e.target.value = '';
  }, [ds]);

  const openResumeGallery = useCallback(async () => {
    if (!window.electronAPI) return;
    const projects = await window.electronAPI.directorListProjects();
    // Wan 2.2: needs video + latent. LTX 2.3: needs video only.
    const resumable = [];
    for (const p of projects) {
      const isLtx = p.meta?.engine === 'ltx23';
      const canResume = isLtx ? p.hasVideo : (p.hasVideo && p.hasLatent);
      if (canResume) {
        const videoUrl = await window.electronAPI.directorGetVideoUrl(p.id);
        resumable.push({ ...p, videoUrl });
      }
    }
    setResumeProjects(resumable);
    setShowResumeGallery(true);
  }, []);

  const handleResumeFromProject = useCallback(async (project) => {
    if (!window.electronAPI) return;
    try {
      const pushed = await window.electronAPI.directorPushVideo({ sessionId: project.id, targetName: `${project.id}.mp4` });
      if (!pushed.ok) throw new Error(`Video push failed: ${pushed.error}`);
      const pushedLat = await window.electronAPI.directorPushLatent({ sessionId: project.id, targetName: `${project.id}.latent` });
      if (!pushedLat.ok) throw new Error(`Latent push failed: ${pushedLat.error}`);
      ds.setInputVideo({ name: pushed.videoName, preview: comfy.getVideoUrl(pushed.videoName, '', 'input') });
      ds.setInputImage(null);
      ds.setResumeContext(project.meta?.intent || '');
      setShowResumeGallery(false);
    } catch (err) { ds.setError(err.message); }
  }, [ds]);

  const handleImportVideo = useCallback(async () => {
    if (!window.electronAPI || !importVae) return;
    try {
      // Pick video file
      const filePath = await window.electronAPI.selectFile([{ name: 'Video', extensions: ['mp4', 'mov', 'avi', 'webm'] }]);
      if (!filePath) return;

      setImportingVideo(true);

      // Upload video to ComfyUI input/
      const file = await fetch('file:///' + filePath.replace(/\\/g, '/')).then(r => r.blob());
      const formData = new FormData();
      formData.append('image', file, filePath.split(/[/\\]/).pop());
      formData.append('subfolder', '');
      formData.append('type', 'input');
      const uploadResp = await fetch('http://127.0.0.1:8188/upload/image', { method: 'POST', body: formData });
      const uploaded = await uploadResp.json();
      if (!uploaded.name) throw new Error('Video upload failed');

      const videoName = uploaded.name;
      const sessionId = `import_${Date.now()}`;

      // Run VideoToLatent workflow
      const wf = buildVideoToLatent({
        vaeModel: importVae,
        videoName,
        latentPrefix: `latents/${sessionId}`,
      });

      // Queue and wait
      const promptResp = await comfy.queuePrompt(wf);
      if (!promptResp.prompt_id) throw new Error('Failed to queue VideoToLatent');

      // Wait for completion
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('VideoToLatent timed out')), 120000);
        const ws = new WebSocket('ws://127.0.0.1:8188/ws?clientId=import');
        ws.onmessage = (e) => {
          try {
            const msg = JSON.parse(e.data);
            if (msg.type === 'executed' && msg.data?.prompt_id === promptResp.prompt_id) {
              clearTimeout(timeout); ws.close(); resolve();
            }
          } catch {}
        };
        ws.onerror = () => { clearTimeout(timeout); reject(new Error('WebSocket error')); };
      });

      // Grab latent and save to project
      const grabbed = await window.electronAPI.directorGrabLatent({ sessionId, prefix: sessionId });
      if (!grabbed.ok) throw new Error(`Latent grab failed: ${grabbed.error}`);

      // Save video to project
      await window.electronAPI.directorSaveVideo({
        sessionId, comfyFilename: videoName, comfySubfolder: '', comfyType: 'input',
      });

      // Save project metadata
      await window.electronAPI.directorSaveProject({ sessionId, metadata: {
        engine: 'wan22',
        intent: `Imported: ${filePath.split(/[/\\]/).pop()}`,
        resolution: 'unknown', videoPreset: 'imported', targetLength: 0,
        completedSegments: 0, hasImage: false, hasVideo: true,
        createdAt: Date.now(), updatedAt: Date.now(),
      }});

      // Refresh gallery
      await openResumeGallery();
      setImportingVideo(false);
    } catch (err) {
      ds.setError(err.message);
      setImportingVideo(false);
    }
  }, [importVae, ds, openResumeGallery]);

  const isRunning = ds.pipelineState === 'running' || ds.pipelineState === 'paused';
  const completedSegs = ds.segments.filter(s => s.status === 'done').length;
  const totalSegs = ds.segments.length;
  const lastVideo = [...ds.segments].reverse().find(s => s.result?.type === 'video');
  const lastVideoUrl = lastVideo?.result?.url || null;
  const viewSeg = selectedSeg >= 0 ? ds.segments[selectedSeg] : null;


  return (
    <div className="h-full flex flex-col bg-bg-900 text-white relative">
      {/* ── Header ── */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-surface-border bg-bg-800 shrink-0">
        <div className="flex items-center gap-3">
          <Film size={16} className="text-amber-400" />
          <span className="text-sm font-semibold">AI Director</span>
          {isRunning && <span className="text-[9px] bg-emerald-500/20 text-emerald-400 px-1.5 py-0.5 rounded-full animate-pulse">LIVE</span>}
          {ds.pipelineState === 'complete' && <span className="text-[9px] bg-emerald-500/20 text-emerald-400 px-1.5 py-0.5 rounded-full">DONE</span>}
        </div>
        <div className="flex items-center gap-2">
          {!isRunning ? (
            <button onClick={handleDirect} disabled={!ds.userIntent}
              className="btn bg-accent text-white text-[10px] px-4 py-1 hover:bg-accent/80 disabled:opacity-30 flex items-center gap-1">
              <Play size={10} /> Direct
            </button>
          ) : (
            <>
              <button onClick={handlePause}
                className="btn btn-ghost text-[10px] px-3 py-1 border border-amber-500/30 text-amber-400 flex items-center gap-1">
                {ds.pipelineState === 'paused' ? <><Play size={10} /> Resume</> : <><Pause size={10} /> Pause</>}
              </button>
              <button onClick={handleStop}
                className="btn bg-red-600 text-white text-[10px] px-3 py-1 flex items-center gap-1">
                <Square size={10} /> Stop
              </button>
            </>
          )}
          <div className="w-px h-4 bg-surface-border mx-1" />
          <button onClick={() => setShowSettings(!showSettings)}
            className={`btn btn-ghost text-[10px] px-2 py-1 border flex items-center gap-1 ${showSettings ? 'border-accent text-accent' : 'border-surface-border text-neutral-500'}`}>
            {showSettings ? <ChevronUp size={10} /> : <ChevronDown size={10} />} Settings
          </button>
          <button onClick={() => setShowTemplates(true)}
            className="btn btn-ghost text-[10px] px-2 py-1 border border-surface-border text-neutral-500 flex items-center gap-1">
            Templates
          </button>
          <button onClick={() => setShowVlmHistory(true)}
            className="btn btn-ghost text-[10px] px-2 py-1 border border-surface-border text-neutral-500 flex items-center gap-1">
            VLM Log {ds.vlmHistory.length > 0 && <span className="text-[8px] bg-emerald-500/20 text-emerald-400 px-1 rounded">{ds.vlmHistory.length}</span>}
          </button>
          <button onClick={() => { ds.fullReset(); if (wsRef.current) wsRef.current.close(); setSelectedSeg(-1); }}
            className="btn btn-ghost text-[10px] px-2 py-1 text-neutral-600 hover:text-red-400">
            <RotateCcw size={10} />
          </button>
        </div>
      </div>

      {/* Settings drawer */}
      {showSettings && (
        <div className="px-4 py-3 border-b border-surface-border bg-bg-800/50 space-y-3 shrink-0 max-h-[35vh] overflow-y-auto">
          <div className="grid grid-cols-4 gap-3">
            <div>
              <label className="text-[9px] text-neutral-500 block mb-1">Target Length</label>
              <div className="flex items-center gap-1">
                <button onClick={() => ds.setTargetLength(Math.max(5, ds.targetLength - 5))} className="btn btn-ghost text-[10px] px-1 border border-surface-border">−</button>
                <span className="flex-1 text-center text-[11px] font-mono text-accent">{ds.targetLength}s</span>
                <button onClick={() => ds.setTargetLength(Math.min(120, ds.targetLength + 5))} className="btn btn-ghost text-[10px] px-1 border border-surface-border">+</button>
              </div>
            </div>
            <div>
              <label className="text-[9px] text-neutral-500 block mb-1">Segment Duration</label>
              <div className="flex items-center gap-1">
                <button onClick={() => ds.setSegmentDuration(Math.max(3, ds.segmentDuration - 1))} className="btn btn-ghost text-[10px] px-1 border border-surface-border">−</button>
                <span className="flex-1 text-center text-[11px] font-mono text-accent">{ds.segmentDuration}s</span>
                <button onClick={() => ds.setSegmentDuration(Math.min(10, ds.segmentDuration + 1))} className="btn btn-ghost text-[10px] px-1 border border-surface-border">+</button>
              </div>
            </div>
            <div>
              <label className="text-[9px] text-neutral-500 block mb-1">Resolution</label>
              <div className="flex gap-1">
                {['portrait', 'square', 'landscape'].map(r => (
                  <button key={r} onClick={() => ds.setResolution(r)}
                    className={`flex-1 text-[9px] py-1 rounded ${ds.resolution === r ? 'bg-accent text-white' : 'bg-bg-700 text-neutral-500'}`}>
                    {r[0].toUpperCase()}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Segment info */}
          {(() => {
            const totalSegs = Math.max(1, Math.ceil(ds.targetLength / ds.segmentDuration));
            const extendSegs = Math.max(0, totalSegs - 1);
            const resetCount = ds.resetEnabled && ds.resetInterval > 0 ? Math.floor(extendSegs / ds.resetInterval) : 0;
            const pureExtends = extendSegs - resetCount; // resets replace extends
            const isFast = ds.videoPreset === 'fast';
            const degradeAt = isFast ? 20 : 30;
            const willDegrade = ds.targetLength > degradeAt && !ds.resetEnabled;
            const totalActual = 1 + pureExtends + (resetCount * 2); // 1 I2V + extends + (reset+I2V pairs)
            return (
              <div className="bg-bg-700/30 rounded-lg px-3 py-2 space-y-1.5">
                <div className="text-[9px] text-neutral-400">
                  {ds.targetLength}s ÷ {ds.segmentDuration}s = <span className="text-accent font-semibold">{totalActual} segments</span>
                  {resetCount > 0
                    ? <span className="text-neutral-500 ml-1">({1 + resetCount} I2V + {pureExtends} extend + {resetCount} reset)</span>
                    : <span className="text-neutral-500 ml-1">(1 I2V + {extendSegs} extend)</span>
                  }
                </div>
                {willDegrade && (
                  <p className="text-[8px] text-amber-400">⚠ {ds.targetLength}s exceeds ~{degradeAt}s — {isFast ? 'fast' : 'quality'} models may degrade. Enable reset to maintain quality.</p>
                )}
              </div>
            );
          })()}

          {/* Reset */}
          <div className="bg-bg-700/30 rounded-lg px-3 py-2 space-y-2">
            <div className="flex items-center justify-between">
              <div>
                <span className="text-[10px] text-neutral-300">Periodic Reset</span>
                <p className="text-[7px] text-neutral-600">SVI PRO guides video back to original frame via end_samples</p>
              </div>
              <button onClick={() => ds.setResetEnabled(!ds.resetEnabled)}
                className={`w-9 h-5 rounded-full relative transition-colors shrink-0 ${ds.resetEnabled ? 'bg-emerald-500' : 'bg-neutral-800 border border-neutral-700'}`}>
                <div className={`w-3.5 h-3.5 bg-white rounded-full absolute top-[3px] transition-all shadow-sm ${ds.resetEnabled ? 'left-[18px]' : 'left-[3px]'}`} />
              </button>
            </div>
            {ds.resetEnabled && (
              <div>
                <label className="text-[8px] text-neutral-500 block mb-0.5">Reset every</label>
                <div className="flex items-center gap-1">
                  <button onClick={() => ds.setResetInterval(Math.max(2, (ds.resetInterval || 4) - 1))} className="btn btn-ghost text-[10px] px-1 border border-surface-border">−</button>
                  <span className="flex-1 text-center text-[10px] font-mono text-emerald-400">{ds.resetInterval || 4} extends</span>
                  <button onClick={() => ds.setResetInterval((ds.resetInterval || 4) + 1)} className="btn btn-ghost text-[10px] px-1 border border-surface-border">+</button>
                </div>
                <p className="text-[7px] text-neutral-600 mt-0.5">VLM sees original image + current end frame → writes bridging prompt → fresh I2V</p>
              </div>
            )}
            {!ds.resetEnabled && (
              <p className="text-[7px] text-neutral-600">⚠ Extending past ~{ds.videoPreset === 'fast' ? '20' : '30'}s without reset will degrade for {ds.videoPreset === 'fast' ? 'fast' : 'quality'} models</p>
            )}
          </div>

          <div className="border-t border-surface-border/50 pt-2 space-y-2">
            {/* Mode toggle */}
            <div className="flex gap-1">
              <button onClick={() => ds.setVideoPreset('fast')} className={`flex-1 text-[10px] py-1.5 rounded font-semibold ${ds.videoPreset === 'fast' ? 'bg-amber-500/20 text-amber-400 border border-amber-500/30' : 'bg-bg-700 text-neutral-500 border border-transparent'}`}>⚡ Fast</button>
              <button onClick={() => ds.setVideoPreset('quality')} className={`flex-1 text-[10px] py-1.5 rounded font-semibold ${ds.videoPreset === 'quality' ? 'bg-violet-500/20 text-violet-400 border border-violet-500/30' : 'bg-bg-700 text-neutral-500 border border-transparent'}`}>🎨 Quality</button>
            </div>
            {/* T2I Preset */}
            <div>
              <label className="text-[9px] text-neutral-500 block mb-0.5">Image Preset</label>
              <select value={ps.selectedPresets[ds.videoPreset]?.t2i || ''}
                onChange={e => ps.setSelectedPreset(ds.videoPreset, 't2i', e.target.value)}
                className="select-field text-[10px] w-full">
                <option value="">None (provide image/video)</option>
                {ps.getPresets('t2i', ds.videoPreset).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
            {/* Video Presets */}
            {ps.separateVideoPresets ? (
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-[9px] text-neutral-500 block mb-0.5">I2V Preset</label>
                  <select value={ps.selectedPresets[ds.videoPreset]?.videoI2V || ''}
                    onChange={e => ps.setSelectedPreset(ds.videoPreset, 'videoI2V', e.target.value)}
                    className="select-field text-[10px] w-full">
                    <option value="">Select...</option>
                    {ps.getPresets('video', ds.videoPreset).filter(p => p.family === 'wan22_i2v').map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                </div>
                <div>
                  <label className="text-[9px] text-neutral-500 block mb-0.5">Extend Preset</label>
                  <select value={ps.selectedPresets[ds.videoPreset]?.videoExtend || ''}
                    onChange={e => ps.setSelectedPreset(ds.videoPreset, 'videoExtend', e.target.value)}
                    className="select-field text-[10px] w-full">
                    <option value="">Select...</option>
                    {ps.getPresets('video', ds.videoPreset).filter(p => p.family === 'wan22_svipro').map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                </div>
              </div>
            ) : (
              <div>
                <label className="text-[9px] text-neutral-500 block mb-0.5">Video Preset</label>
                <select value={ps.selectedPresets[ds.videoPreset]?.video || ''}
                  onChange={e => ps.setSelectedPreset(ds.videoPreset, 'video', e.target.value)}
                  className="select-field text-[10px] w-full">
                  <option value="">Select...</option>
                  {ps.getPresets('video', ds.videoPreset).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </div>
            )}
            {ps.getPresets('video', ds.videoPreset).length === 0 && (
              <p className="text-[9px] text-amber-400">⚠ No {ds.videoPreset} video presets. Create one in the Presets tab.</p>
            )}
          </div>
          {/* Processing toggles */}
          <div className="border-t border-surface-border/50 pt-2 space-y-2">
            <div className="grid grid-cols-5 gap-3">
              <div>
                <label className="text-[9px] text-neutral-500 block mb-1">HD Mode</label>
                <button onClick={() => ds.setHighRes(!ds.highRes)}
                  className={`w-full text-[10px] py-1 rounded ${ds.highRes ? 'bg-accent text-white' : 'bg-bg-700 text-neutral-500'}`}>
                  {ds.highRes ? 'HD' : 'SD'}
                </button>
              </div>
              <div>
                <label className="text-[9px] text-neutral-500 block mb-1">Smart LoRA</label>
                <button onClick={() => ds.setUseSmartLora(!ds.useSmartLora)}
                  className={`w-9 h-5 rounded-full relative transition-colors ${ds.useSmartLora ? 'bg-violet-500' : 'bg-neutral-700'}`}>
                  <div className={`w-3.5 h-3.5 bg-white rounded-full absolute top-[3px] transition-all ${ds.useSmartLora ? 'left-[19px]' : 'left-[3px]'}`} />
                </button>
              </div>
              <div>
                <label className="text-[9px] text-neutral-500 block mb-1">Planner</label>
                <button onClick={() => ds.setUsePlanner(!ds.usePlanner)}
                  className={`w-9 h-5 rounded-full relative transition-colors ${ds.usePlanner ? 'bg-amber-500' : 'bg-neutral-700'}`}>
                  <div className={`w-3.5 h-3.5 bg-white rounded-full absolute top-[3px] transition-all ${ds.usePlanner ? 'left-[19px]' : 'left-[3px]'}`} />
                </button>
              </div>
              <div>
                <label className="text-[9px] text-neutral-500 block mb-1">Body Fix</label>
                <button onClick={() => ds.setUseBodyFix(!ds.useBodyFix)}
                  className={`w-9 h-5 rounded-full relative transition-colors ${ds.useBodyFix ? 'bg-emerald-500' : 'bg-neutral-700'}`}>
                  <div className={`w-3.5 h-3.5 bg-white rounded-full absolute top-[3px] transition-all ${ds.useBodyFix ? 'left-[19px]' : 'left-[3px]'}`} />
                </button>
              </div>
              <div>
                <label className="text-[9px] text-neutral-500 block mb-1">HireFix</label>
                <button onClick={() => ds.setUseHireFix(!ds.useHireFix)}
                  className={`w-9 h-5 rounded-full relative transition-colors ${ds.useHireFix ? 'bg-emerald-500' : 'bg-neutral-700'}`}>
                  <div className={`w-3.5 h-3.5 bg-white rounded-full absolute top-[3px] transition-all ${ds.useHireFix ? 'left-[19px]' : 'left-[3px]'}`} />
                </button>
              </div>
              <div>
                <label className="text-[9px] text-neutral-500 block mb-1">VLM Frames</label>
                <div className="flex items-center gap-1">
                  <button onClick={() => ds.setDirectorFrameCount(Math.max(2, ds.directorFrameCount - 2))} className="btn btn-ghost text-[10px] px-1 border border-surface-border">−</button>
                  <span className="flex-1 text-center text-[10px] font-mono text-accent">{ds.directorFrameCount}</span>
                  <button onClick={() => ds.setDirectorFrameCount(Math.min(16, ds.directorFrameCount + 2))} className="btn btn-ghost text-[10px] px-1 border border-surface-border">+</button>
                </div>
              </div>
              <div>
                <label className="text-[9px] text-neutral-500 block mb-1">Auto-approve</label>
                <button onClick={() => ds.setAutoApprove(!ds.autoApprove)}
                  className={`w-9 h-5 rounded-full relative transition-colors ${ds.autoApprove ? 'bg-accent' : 'bg-neutral-700'}`}>
                  <div className={`w-3.5 h-3.5 bg-white rounded-full absolute top-[3px] transition-all ${ds.autoApprove ? 'left-[19px]' : 'left-[3px]'}`} />
                </button>
              </div>
            </div>
            {/* Conditional settings for enabled features */}
            {(ds.useBodyFix || ds.useHireFix || ds.usePlanner) && (
              <div className="grid grid-cols-2 gap-3">
                {ds.usePlanner && (
                  <div>
                    <label className="text-[9px] text-neutral-500 block mb-1">Planner Max Retries</label>
                    <div className="flex items-center gap-1">
                      <button onClick={() => ds.setPlannerMaxRetries(Math.max(0, (ds.plannerMaxRetries || 2) - 1))} className="btn btn-ghost text-[10px] px-1 border border-surface-border">−</button>
                      <span className="flex-1 text-center text-[10px] font-mono text-accent">{ds.plannerMaxRetries || 2}</span>
                      <button onClick={() => ds.setPlannerMaxRetries(Math.min(5, (ds.plannerMaxRetries || 2) + 1))} className="btn btn-ghost text-[10px] px-1 border border-surface-border">+</button>
                    </div>
                  </div>
                )}
                {ds.useBodyFix && (
                  <div>
                    <label className="text-[9px] text-neutral-500 block mb-1">Body Fix Edit Model</label>
                    <select value={ds.bodyFixCheckpoint} onChange={(e) => ds.setBodyFixCheckpoint(e.target.value)} className="select-field text-[10px] w-full">
                      <option value="">Select edit model...</option>
                      {vs.comfyCheckpoints.map(c => <option key={c} value={c}>{c.split(/[/\\]/).pop()}</option>)}
                    </select>
                    {!ds.bodyFixCheckpoint && <p className="text-[8px] text-red-400 mt-0.5">Required — select an edit model</p>}
                  </div>
                )}
                {ds.useHireFix && (
                  <div className="space-y-1.5">
                    <label className="text-[9px] text-neutral-500 block">HireFix Edit Model</label>
                    <select value={ds.hireFixCheckpoint} onChange={(e) => ds.setHireFixCheckpoint(e.target.value)} className="select-field text-[10px] w-full">
                      <option value="">Select edit model...</option>
                      {vs.comfyCheckpoints.map(c => <option key={c} value={c}>{c.split(/[/\\]/).pop()}</option>)}
                    </select>
                    {!ds.hireFixCheckpoint && <p className="text-[8px] text-red-400">Required</p>}
                    <div className="flex gap-1">
                      <button onClick={() => ds.setHireFixMode('fast')} className={`flex-1 text-[9px] py-1 rounded ${ds.hireFixMode === 'fast' ? 'bg-accent text-white' : 'bg-bg-700 text-neutral-500'}`}>Fast</button>
                      <button onClick={() => ds.setHireFixMode('latent')} className={`flex-1 text-[9px] py-1 rounded ${ds.hireFixMode === 'latent' ? 'bg-accent text-white' : 'bg-bg-700 text-neutral-500'}`}>Quality</button>
                    </div>
                    <div className="grid grid-cols-2 gap-1.5">
                      <div>
                        <label className="text-[8px] text-neutral-600">Upscale By</label>
                        <select value={ds.hireFixUpscaleBy} onChange={(e) => ds.setHireFixUpscaleBy(parseFloat(e.target.value))} className="select-field text-[9px] w-full">
                          {[1.15, 1.25, 1.5, 2.0].map(v => <option key={v} value={v}>{v}×</option>)}
                        </select>
                      </div>
                      <div>
                        <label className="text-[8px] text-neutral-600">Denoise</label>
                        <select value={ds.hireFixDenoise} onChange={(e) => ds.setHireFixDenoise(parseFloat(e.target.value))} className="select-field text-[9px] w-full">
                          {[0.2, 0.3, 0.4, 0.5, 0.6, 0.7].map(v => <option key={v} value={v}>{v}</option>)}
                        </select>
                      </div>
                    </div>
                    <div>
                      <label className="text-[8px] text-neutral-600">Upscale Model</label>
                      <select value={ds.hireFixUpscaleModel} onChange={(e) => ds.setHireFixUpscaleModel(e.target.value)} className="select-field text-[9px] w-full">
                        <option value="">Default</option>
                        {vs.comfyUpscaleModels.map(m => <option key={m} value={m}>{m.split(/[/\\]/).pop()}</option>)}
                      </select>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}



      {/* ── Workspace: Controls (left) + Preview (right) ── */}
      <div className="flex-1 flex overflow-hidden min-h-0">

        {/* ── Left: Controls Panel ── */}
        <div className="w-64 shrink-0 border-r border-surface-border bg-bg-800/30 flex flex-col overflow-y-auto">
          <div className="p-3 space-y-3 flex-1">

            {/* Error */}
            {ds.error && (
              <div className="bg-red-500/10 border border-red-500/30 rounded-lg px-2.5 py-2 flex items-start gap-1.5">
                <AlertCircle size={10} className="text-red-400 mt-0.5 shrink-0" />
                <span className="text-[9px] text-red-300 flex-1 leading-relaxed">{ds.error}</span>
                <button onClick={() => ds.setError(null)} className="text-red-400 shrink-0"><X size={9} /></button>
              </div>
            )}

            {/* Intent */}
            <div>
              <label className="text-[8px] text-amber-400 font-semibold uppercase tracking-wider block mb-1">Vision</label>
              <textarea value={ds.userIntent} onChange={(e) => ds.setUserIntent(e.target.value)}
                placeholder="Tell the AI what you want to see..."
                rows={3} className="input-field text-[10px] resize-none w-full leading-relaxed border-amber-500/20 focus:border-amber-500/50" />
            </div>

            {/* Camera */}
            <div>
              <label className="text-[8px] text-neutral-500 uppercase tracking-wider block mb-1">Camera</label>
              <div className="flex gap-1">
                {[{ val: 'static', label: 'Static' }, { val: 'smart', label: 'Smart' }, { val: 'dynamic', label: 'Dynamic' }].map(o => (
                  <button key={o.val} onClick={() => ds.setCameraMode(o.val)}
                    className={`flex-1 text-[8px] py-1 rounded font-medium transition-colors ${ds.cameraMode === o.val ? 'bg-accent/20 text-accent border border-accent/30' : 'bg-bg-700 text-neutral-600 border border-transparent'}`}>
                    {o.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Lighting */}
            <div>
              <label className="text-[8px] text-neutral-500 uppercase tracking-wider block mb-1">Lighting</label>
              <div className="flex gap-1">
                {[{ val: 'locked', label: 'Locked' }, { val: 'natural', label: 'Natural' }, { val: 'creative', label: 'Creative' }].map(o => (
                  <button key={o.val} onClick={() => ds.setLightingMode(o.val)}
                    className={`flex-1 text-[8px] py-1 rounded font-medium transition-colors ${ds.lightingMode === o.val ? 'bg-accent/20 text-accent border border-accent/30' : 'bg-bg-700 text-neutral-600 border border-transparent'}`}>
                    {o.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Resume From */}
            <div>
              <label className="text-[8px] text-neutral-500 uppercase tracking-wider block mb-1">Start From</label>
              {ds.inputImage ? (
                <div className="relative rounded-lg overflow-hidden bg-black border border-surface-border aspect-video">
                  <img src={ds.inputImage.preview} className="w-full h-full object-cover" />
                  <button onClick={() => { ds.setInputImage(null); ds.setResumeContext(''); }}
                    className="absolute top-1 right-1 bg-black/70 rounded-full p-0.5 hover:bg-black"><X size={8} className="text-white" /></button>
                  <span className="absolute bottom-1 left-1 text-[7px] bg-accent/80 text-white px-1.5 rounded">Image → I2V</span>
                </div>
              ) : ds.inputVideo ? (
                <div className="relative rounded-lg overflow-hidden bg-black border border-surface-border aspect-video">
                  <video src={ds.inputVideo.preview} className="w-full h-full object-cover" muted />
                  <button onClick={() => { ds.setInputVideo(null); ds.setResumeContext(''); }}
                    className="absolute top-1 right-1 bg-black/70 rounded-full p-0.5 hover:bg-black"><X size={8} className="text-white" /></button>
                  <span className="absolute bottom-1 left-1 text-[7px] bg-emerald-500/80 text-white px-1.5 rounded">Video → Extend</span>
                </div>
              ) : (
                <div className="flex gap-1.5">
                  <button onClick={() => imgInputRef.current?.click()}
                    className="flex-1 flex items-center justify-center gap-1 py-3 bg-bg-700 rounded-lg border border-dashed border-surface-border hover:border-accent/50 text-[9px] text-neutral-500">
                    <ImageIcon size={12} /> Image
                  </button>
                  <button onClick={openResumeGallery}
                    className="flex-1 flex items-center justify-center gap-1 py-3 bg-bg-700 rounded-lg border border-dashed border-surface-border hover:border-accent/50 text-[9px] text-neutral-500">
                    <Film size={12} /> Video
                  </button>
                </div>
              )}
              <input ref={imgInputRef} type="file" accept="image/*" className="hidden" onChange={handleImageUpload} />
              {(ds.inputImage || ds.inputVideo) && (
                <textarea value={ds.resumeContext} onChange={(e) => ds.setResumeContext(e.target.value)}
                  placeholder={ds.inputImage ? "Describe this image..." : "Describe this video..."}
                  rows={2} className="input-field text-[9px] resize-none w-full mt-1.5" />
              )}
            </div>

            {/* Optional Details */}
            <button onClick={() => setShowOptionals(!showOptionals)}
              className="flex items-center gap-1 text-[8px] text-neutral-600 hover:text-neutral-400 w-full">
              {showOptionals ? <ChevronUp size={9} /> : <ChevronDown size={9} />}
              <span>Optional Details</span>
              {(ds.storyBrief || ds.motionStyle) && <span className="w-1.5 h-1.5 rounded-full bg-accent ml-1" />}
            </button>
            {showOptionals && (
              <div className="space-y-2 pl-2 border-l-2 border-surface-border/30">
                <div>
                  <label className="text-[8px] text-neutral-600 block mb-0.5">Story Brief</label>
                  <textarea value={ds.storyBrief} onChange={(e) => ds.setStoryBrief(e.target.value)}
                    placeholder="Optional storyline..." rows={2} className="input-field text-[9px] resize-none w-full" />
                </div>
                <div>
                  <label className="text-[8px] text-neutral-600 block mb-0.5">Motion Style</label>
                  <textarea value={ds.motionStyle} onChange={(e) => ds.setMotionStyle(e.target.value)}
                    placeholder="How things move..." rows={2} className="input-field text-[9px] resize-none w-full" />
                </div>
              </div>
            )}

            {/* Planner Plan */}
            {ds.usePlanner && ds.plannerSegments.length > 0 && (
              <div>
                <label className="text-[8px] text-amber-400 uppercase tracking-wider block mb-1">Plan</label>
                <div className="space-y-1">
                  {ds.plannerSegments.map((p, idx) => (
                    <div key={idx} className={`px-2 py-1 rounded text-[8px] leading-relaxed border ${p.approved ? 'bg-emerald-500/5 border-emerald-500/20 text-emerald-300' : 'bg-bg-700 border-surface-border/30 text-neutral-400'}`}>
                      <span className="font-bold text-neutral-500">{idx + 1}.</span> {p.description}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* ── Right: Preview Monitor ── */}
        <div className="flex-1 flex flex-col min-w-0">
          {/* Video */}
          <div className="flex-1 bg-black flex items-center justify-center relative min-h-0">
            {lastVideoUrl ? (
              <video key={lastVideoUrl} src={lastVideoUrl} controls autoPlay loop muted className="max-h-full max-w-full object-contain" playsInline />
            ) : ds.inputImage ? (
              <img src={ds.inputImage.preview} className="max-h-full max-w-full object-contain opacity-40" />
            ) : (
              <div className="text-center px-8">
                <Film size={40} className="text-neutral-800 mx-auto mb-2" />
                <p className="text-[11px] text-neutral-600">Write your vision and hit Direct</p>
              </div>
            )}
            {/* Status overlay */}
            {ds.pipelineStatus && isRunning && (
              <div className="absolute bottom-0 inset-x-0 bg-gradient-to-t from-black/90 via-black/50 to-transparent px-4 py-3">
                <div className="flex items-center gap-2 text-[10px] text-neutral-300">
                  <Loader size={10} className="animate-spin text-accent shrink-0" />
                  <span className="truncate">{ds.pipelineStatus}</span>
                  {ds.currentEstimate && <span className="text-amber-400 font-mono ml-auto shrink-0">{ds.currentEstimate.text}</span>}
                </div>
              </div>
            )}
          </div>
          {/* Preview toolbar */}
          <div className="flex items-center gap-3 px-3 py-1.5 bg-bg-800 border-t border-surface-border shrink-0">
            <button onClick={() => setShowPrompts(true)} disabled={ds.segments.filter(s => s.prompt).length === 0}
              className="flex items-center gap-1 text-[9px] text-neutral-500 hover:text-neutral-300 disabled:opacity-30">
              <Edit3 size={9} /> Prompts ({ds.segments.filter(s => s.prompt).length})
            </button>
            {lastVideoUrl && (
              <button onClick={async () => {
                if (!lastVideo?.result || !window.electronAPI) return;
                await window.electronAPI.saveComfyFileAs({
                  comfyFilename: lastVideo.result.filename, comfySubfolder: lastVideo.result.subfolder || '', comfyType: 'input',
                  defaultName: `director_${Date.now()}.mp4`, filters: [{ name: 'Video', extensions: ['mp4'] }],
                });
              }} className="flex items-center gap-1 text-[9px] text-neutral-500 hover:text-neutral-300">
                <Download size={9} /> Save
              </button>
            )}
            {ds.pipelineState === 'complete' && lastVideoUrl && (
              <button onClick={() => {
                if (lastVideo?.result) ds.setInputVideo({ name: lastVideo.result.filename, preview: lastVideo.result.url });
                ds.reset(); ds.setTargetLength(ds.targetLength);
              }} className="flex items-center gap-1 text-[9px] text-emerald-400 hover:text-emerald-300 ml-auto">
                <Play size={9} /> Extend More
              </button>
            )}
          </div>
        </div>
      </div>

      {/* ── Bottom: Timeline + Approval ── */}
      <div className="shrink-0 border-t border-surface-border bg-bg-800/50">
        {/* Approval bar */}
        {ds.awaitingApproval && (
          <div className="px-4 py-2 border-b border-amber-500/20 bg-amber-500/5">
            <div className="flex items-center gap-2 mb-1.5">
              <Edit3 size={10} className="text-amber-400 shrink-0" />
              <span className="text-[9px] text-amber-400 font-semibold">Review prompt</span>
            </div>
            <div className="flex gap-2">
              <textarea value={ds.currentPrompt} onChange={(e) => ds.setCurrentPrompt(e.target.value)}
                rows={2} className="input-field text-[10px] resize-none flex-1" />
              <button onClick={handleApprove} className="btn bg-emerald-600 text-white text-[10px] px-4 py-1.5 shrink-0 self-end flex items-center gap-1">
                <Check size={10} /> Approve
              </button>
            </div>
          </div>
        )}

        {/* Timeline strip */}
        <div className="px-4 py-2">
          {ds.segments.length > 0 ? (
            <>
              <div className="flex items-center gap-2 mb-1.5">
                <span className="text-[8px] text-neutral-500 uppercase tracking-wider font-semibold">Timeline</span>
                <span className="text-[9px] text-neutral-400 font-mono">{completedSegs}/{totalSegs}</span>
                <div className="flex-1 h-1.5 bg-bg-700 rounded-full overflow-hidden">
                  <div className="h-full bg-accent rounded-full transition-all duration-500" style={{ width: `${totalSegs > 0 ? Math.round((completedSegs / totalSegs) * 100) : 0}%` }} />
                </div>
                {ds.currentEstimate && isRunning && (
                  <span className="text-[9px] text-amber-400 font-mono shrink-0">{ds.currentEstimate.text}</span>
                )}
              </div>
              <div className="flex gap-1 overflow-x-auto pb-1">
                {ds.segments.map((seg, i) => {
                  const done = seg.status === 'done';
                  const active = seg.status === 'active';
                  const typeLabel = seg.type === 'image' ? 'T2I' : seg.type === 'i2v' ? 'I2V' : seg.type === 'reset' ? 'RST' : 'EXT';
                  return (
                    <div key={seg.id} className={`shrink-0 flex items-center gap-1 px-2.5 py-1.5 rounded-md text-[9px] font-semibold border transition-all
                      ${done ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400' :
                        active ? 'bg-accent/10 border-accent/40 text-accent' :
                        'bg-bg-700/80 border-surface-border/50 text-neutral-600'}`}>
                      <span className="uppercase tracking-wide">{typeLabel}</span>
                      {done && <Check size={8} />}
                      {active && <Loader size={8} className="animate-spin" />}
                    </div>
                  );
                })}
              </div>
            </>
          ) : (
            <div className="text-[9px] text-neutral-700 text-center py-1">No segments — write a vision and hit Direct</div>
          )}
        </div>
      </div>

      {/* ── Resume Gallery Overlay ── */}
      {showResumeGallery && (
        <div className="absolute inset-0 bg-black/80 z-50 flex items-center justify-center p-8">
          <div className="bg-bg-800 rounded-xl border border-surface-border w-full max-w-3xl max-h-[75vh] flex flex-col">
            <div className="flex items-center justify-between px-4 py-3 border-b border-surface-border">
              <div>
                <span className="text-sm font-semibold">Resume from Director Project</span>
                <span className="text-[9px] text-neutral-500 ml-2">Wan: video + latent • LTX: video only</span>
              </div>
              <button onClick={() => setShowResumeGallery(false)}><X size={14} className="text-neutral-500 hover:text-white" /></button>
            </div>

            {/* Import section */}
            <div className="px-4 py-3 border-b border-surface-border bg-bg-700/30">
              <div className="flex items-center gap-3">
                <div className="flex-1">
                  <label className="text-[8px] text-neutral-500 uppercase tracking-wider block mb-1">Wan 2.2 VAE</label>
                  <select value={importVae} onChange={e => setImportVae(e.target.value)}
                    className="input-field text-[10px] w-full">
                    <option value="">Select VAE...</option>
                    {(vs.comfyVaes || []).map(v => <option key={v} value={v}>{v.split(/[/\\]/).pop()}</option>)}
                  </select>
                </div>
                <button onClick={handleImportVideo} disabled={!importVae || importingVideo}
                  className="btn bg-accent text-white text-[10px] px-4 py-2 mt-3 flex items-center gap-1.5 disabled:opacity-30 shrink-0">
                  {importingVideo ? <><Loader size={10} className="animate-spin" /> Encoding...</> : <><Upload size={10} /> Import Video</>}
                </button>
              </div>
              <p className="text-[8px] text-amber-400/70 mt-1.5">⚠ Must be a Wan 2.2 VAE — other VAEs produce incompatible latents</p>
            </div>

            {/* Project grid */}
            <div className="flex-1 overflow-y-auto p-4">
              {resumeProjects.length === 0 ? (
                <div className="text-center py-12">
                  <Film size={36} className="text-neutral-700 mx-auto mb-2" />
                  <p className="text-[10px] text-neutral-600">No resumable projects found</p>
                  <p className="text-[9px] text-neutral-700 mt-1">Import a video above or complete a Director run</p>
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-3">
                  {resumeProjects.map(p => (
                    <button key={p.id} onClick={() => handleResumeFromProject(p)}
                      className="text-left bg-bg-700 rounded-lg border border-surface-border hover:border-accent/50 overflow-hidden transition-colors group">
                      <div className="aspect-video bg-black relative">
                        {p.videoUrl ? (
                          <video src={p.videoUrl} className="w-full h-full object-cover" muted preload="metadata"
                            onMouseEnter={e => e.target.play()} onMouseLeave={e => { e.target.pause(); e.target.currentTime = 0; }} />
                        ) : (
                          <div className="w-full h-full flex items-center justify-center"><Film size={24} className="text-neutral-700" /></div>
                        )}
                        <div className="absolute top-1.5 right-1.5 flex gap-1">
                          <span className={`text-[7px] px-1.5 py-0.5 rounded font-semibold ${
                            p.meta?.engine === 'ltx23' ? 'bg-cyan-500/80 text-white' : 'bg-amber-500/80 text-white'
                          }`}>{p.meta?.engine === 'ltx23' ? 'LTX' : 'Wan'}</span>
                          {p.hasLatent && <span className="text-[7px] bg-emerald-500/80 text-white px-1.5 py-0.5 rounded font-semibold">Latent ✓</span>}
                        </div>
                        <div className="absolute inset-0 bg-accent/0 group-hover:bg-accent/10 transition-colors flex items-center justify-center">
                          <Play size={20} className="text-white opacity-0 group-hover:opacity-80 transition-opacity" />
                        </div>
                      </div>
                      <div className="px-3 py-2">
                        <p className="text-[10px] text-neutral-300 truncate">{p.meta?.intent || p.id}</p>
                        <div className="flex items-center gap-2 mt-1 text-[8px] text-neutral-500">
                          {p.meta?.targetLength > 0 && <span>{p.meta.targetLength}s</span>}
                          {p.meta?.completedSegments > 0 && <span>{p.meta.completedSegments} segs</span>}
                          {p.meta?.resolution && p.meta.resolution !== 'unknown' && <span>{p.meta.resolution}</span>}
                          {p.videoSize > 0 && <span>{(p.videoSize / 1024 / 1024).toFixed(1)}MB</span>}
                        </div>
                        <p className="text-[8px] text-neutral-600 mt-0.5">
                          {p.meta?.updatedAt ? new Date(p.meta.updatedAt).toLocaleDateString() : ''}
                        </p>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── Prompts Overlay ── */}
      {showPrompts && (
        <div className="absolute inset-0 bg-black/80 z-50 flex items-center justify-center p-8">
          <div className="bg-bg-800 rounded-xl border border-surface-border w-full max-w-2xl max-h-[70vh] flex flex-col">
            <div className="flex items-center justify-between px-4 py-3 border-b border-surface-border">
              <span className="text-sm font-semibold">Segment Prompts</span>
              <button onClick={() => setShowPrompts(false)}><X size={14} className="text-neutral-500 hover:text-white" /></button>
            </div>
            <div className="flex-1 overflow-y-auto divide-y divide-surface-border/30">
              {ds.segments.filter(s => s.prompt).map((seg, idx) => {
                const segIdx = ds.segments.indexOf(seg);
                const typeLabel = seg.type === 'image' ? 'T2I' : seg.type === 'i2v' ? 'I2V' : seg.type === 'reset' ? 'Reset' : 'Extend';
                return (
                  <div key={segIdx} className="px-4 py-3">
                    <div className="flex items-center gap-2 mb-1">
                      <span className={`text-[8px] font-bold uppercase px-1.5 py-0.5 rounded ${
                        seg.type === 'reset' ? 'bg-amber-500/20 text-amber-400' :
                        seg.type === 'i2v' ? 'bg-accent/20 text-accent' :
                        'bg-neutral-700 text-neutral-400'}`}>
                        {typeLabel}
                      </span>
                      <span className="text-[9px] text-neutral-600">Segment {segIdx + 1}</span>
                    </div>
                    <p className="text-[10px] text-neutral-300 leading-relaxed">{seg.prompt}</p>
                  </div>
                );
              })}
              {ds.segments.filter(s => s.prompt).length === 0 && (
                <div className="px-4 py-8 text-center text-[10px] text-neutral-600">No prompts generated yet</div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Template Editor Overlay */}
      {showTemplates && (
        <div className="absolute inset-0 bg-black/80 z-50 flex items-center justify-center p-8">
          <div className="bg-bg-800 rounded-xl border border-surface-border w-full max-w-4xl max-h-[80vh] flex flex-col">
            <div className="flex items-center justify-between px-4 py-3 border-b border-surface-border">
              <span className="text-sm font-semibold">Prompt Templates</span>
              <div className="flex gap-2">
                <button onClick={() => {
                  ds.setTemplateImage(DEFAULT_TEMPLATE_IMAGE);
                  ds.setTemplateI2V(DEFAULT_TEMPLATE_I2V);
                  ds.setTemplateExtend(DEFAULT_TEMPLATE_EXTEND);
                  ds.setTemplatePlan(DEFAULT_TEMPLATE_PLAN);
                  ds.setTemplatePlanReview(DEFAULT_TEMPLATE_PLAN_REVIEW);
                  ds.setTemplateLoraSelect(DEFAULT_TEMPLATE_LORA_SELECT);
                }} className="btn btn-ghost text-[10px] px-3 py-1 border border-amber-500/30 text-amber-400">Reset All</button>
                <button onClick={() => setShowTemplates(false)} className="text-neutral-500 hover:text-white"><X size={16} /></button>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto p-4 space-y-4">
              <p className="text-[9px] text-neutral-500">
                Variables: <code className="text-accent">{'{intent}'}</code> <code className="text-accent">{'{brief}'}</code> <code className="text-accent">{'{research}'}</code> <code className="text-accent">{'{motionStyle}'}</code> <code className="text-accent">{'{resumeContext}'}</code> <code className="text-accent">{'{cameraControl}'}</code> <code className="text-accent">{'{lightingControl}'}</code> <code className="text-accent">{'{segNum}'}</code> <code className="text-accent">{'{totalSegs}'}</code> <code className="text-accent">{'{segDuration}'}</code> <code className="text-accent">{'{totalDuration}'}</code> <code className="text-accent">{'{segsRemaining}'}</code> <code className="text-accent">{'{hint}'}</code> <code className="text-accent">{'{snippets}'}</code> <code className="text-accent">{'{lastPrompt}'}</code> <code className="text-accent">{'{planDescription}'}</code>
              </p>
              {[
                { label: 'Image Prompt (T2I)', value: ds.templateImage, set: (v) => ds.setTemplateImage(v) },
                { label: 'Video Prompt (I2V)', value: ds.templateI2V, set: (v) => ds.setTemplateI2V(v) },
                { label: 'Extend Prompt', value: ds.templateExtend, set: (v) => ds.setTemplateExtend(v) },
                { label: 'Planner — Segment Plan', value: ds.templatePlan, set: (v) => ds.setTemplatePlan(v) },
                { label: 'Planner — Review Output', value: ds.templatePlanReview, set: (v) => ds.setTemplatePlanReview(v) },
                { label: 'Smart LoRA — Selection', value: ds.templateLoraSelect, set: (v) => ds.setTemplateLoraSelect(v) },
              ].map((t) => (
                <div key={t.label}>
                  <label className="text-[10px] text-neutral-400 font-semibold block mb-1">{t.label}</label>
                  <textarea value={t.value} onChange={(e) => t.set(e.target.value)}
                    rows={6} className="input-field text-[9px] resize-y w-full font-mono leading-relaxed" />
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* VLM History Overlay */}
      {showVlmHistory && (
        <div className="absolute inset-0 bg-black/80 z-50 flex items-center justify-center p-6">
          <div className="bg-bg-800 rounded-xl border border-surface-border w-full max-w-4xl max-h-[85vh] flex flex-col">
            <div className="flex items-center justify-between px-4 py-3 border-b border-surface-border shrink-0">
              <div className="flex items-center gap-3">
                <span className="text-sm font-semibold">VLM History</span>
                <span className="text-[9px] text-neutral-500">{ds.vlmHistory.length} exchanges</span>
              </div>
              <div className="flex gap-2">
                <button onClick={() => ds.clearVlmHistory()} className="btn btn-ghost text-[10px] px-3 py-1 border border-red-500/30 text-red-400">Clear All</button>
                <button onClick={() => setShowVlmHistory(false)} className="text-neutral-500 hover:text-white"><X size={16} /></button>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto p-4 space-y-2">
              {ds.vlmHistory.length === 0 ? (
                <div className="text-center py-12">
                  <p className="text-neutral-600 text-sm">No VLM interactions yet</p>
                  <p className="text-neutral-700 text-[10px] mt-1">Run the Director pipeline to see prompts and responses here.</p>
                </div>
              ) : ds.vlmHistory.map((h, idx) => (
                <div key={idx} className={`rounded-lg border overflow-hidden ${h.role === 'app' ? 'bg-bg-700 border-accent/20' : h.role === 'planner' ? 'bg-bg-700 border-amber-500/20' : 'bg-bg-800 border-emerald-500/20'}`}>
                  <div className="flex items-center gap-2 px-3 py-1.5 border-b border-surface-border/30 bg-black/20">
                    <span className={`text-[8px] font-bold uppercase px-1.5 py-0.5 rounded ${
                      h.role === 'app' ? 'bg-accent/20 text-accent' :
                      h.role === 'planner' ? 'bg-amber-500/20 text-amber-400' :
                      'bg-emerald-500/20 text-emerald-400'
                    }`}>{h.role === 'app' ? 'APP → VLM' : h.role === 'planner' ? 'PLANNER' : 'VLM → APP'}</span>
                    <span className="text-[8px] text-neutral-500 font-mono">{h.phase}</span>
                    <span className="text-[8px] text-neutral-700 ml-auto">{new Date(h.timestamp).toLocaleTimeString()}</span>
                  </div>
                  <pre className="px-3 py-2 text-[10px] text-neutral-300 leading-relaxed whitespace-pre-wrap break-words font-mono overflow-x-auto">{h.text}</pre>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
