import React, { useState, useEffect, useCallback } from 'react';
import useStore from '../../lib/store';
import useSessionStore from '../../lib/sessionStore';
import * as comfy from '../../lib/comfyui';
import {
  FolderOpen, Plus, Trash2, ArrowRight, Film, Pencil, Play, Download,
  X, Sparkles, ChevronRight, FolderPlus, Image as ImageIcon, Loader2,
  Upload, RefreshCw,
} from 'lucide-react';

// ── Simple viewer overlay for imported media ──
function MediaViewer({ item, onClose, onSendTo }) {
  const [showSendMenu, setShowSendMenu] = useState(false);
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center" style={{ WebkitAppRegion: 'no-drag' }}>
      <div className="absolute inset-0 bg-black/80 backdrop-blur-sm" onClick={onClose} />
      <div className="relative flex w-[92%] h-[88%] max-w-[1400px] rounded-xl overflow-hidden border border-surface-border shadow-2xl bg-bg-900">
        <div className="flex-1 flex flex-col min-w-0">
          <div className="flex-1 flex items-center justify-center overflow-hidden p-4">
            {item.isVideo ? (
              <video src={item.preview} className="max-h-full max-w-full rounded-lg" autoPlay loop muted controls />
            ) : (
              <img src={item.preview} className="max-h-full max-w-full object-contain rounded" />
            )}
          </div>
          <div className="flex items-center justify-between px-4 py-2 bg-bg-800/80 border-t border-surface-border">
            <span className="text-[10px] text-neutral-500 truncate flex-1">{item.filename}</span>
            <div className="flex items-center gap-2">
              <div className="relative">
                <button onClick={() => setShowSendMenu(!showSendMenu)}
                  className="btn btn-ghost text-[10px] px-2 py-1 border border-accent/30 text-accent flex items-center gap-1">
                  <ArrowRight size={11} /> Send to...
                </button>
                {showSendMenu && (
                  <div className="absolute bottom-full right-0 mb-1 bg-bg-800 border border-surface-border rounded-lg shadow-xl py-1 min-w-[180px] z-10">
                    <button onClick={() => { onSendTo('longvideo'); onClose(); }}
                      className="w-full text-left px-3 py-1.5 text-[11px] text-neutral-300 hover:bg-bg-700 flex items-center gap-2">
                      <Film size={11} className="text-accent" /> Long Video
                    </button>
                    {!item.isVideo && (<>
                      <button onClick={() => { onSendTo('animate'); onClose(); }}
                        className="w-full text-left px-3 py-1.5 text-[11px] text-neutral-300 hover:bg-bg-700 flex items-center gap-2">
                        <Play size={11} className="text-emerald-400" /> Animate Image
                      </button>
                      <button onClick={() => { onSendTo('editor'); onClose(); }}
                        className="w-full text-left px-3 py-1.5 text-[11px] text-neutral-300 hover:bg-bg-700 flex items-center gap-2">
                        <Pencil size={11} className="text-purple-400" /> Editor
                      </button>
                    </>)}
                  </div>
                )}
              </div>
              <button onClick={onClose} className="text-neutral-500 hover:text-white"><X size={16} /></button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Session picker popup ──
function SessionPicker({ sessions, onSelect, onCreateNew, onCancel }) {
  const [newName, setNewName] = useState('');
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ WebkitAppRegion: 'no-drag' }}>
      <div className="absolute inset-0 bg-black/60" onClick={onCancel} />
      <div className="relative bg-bg-800 border border-surface-border rounded-xl shadow-2xl p-5 w-80 space-y-3">
        <h3 className="text-sm font-semibold text-neutral-200">Choose a Studio Session</h3>
        <p className="text-[10px] text-neutral-500">A package will be created in the selected session.</p>
        <div className="max-h-40 overflow-y-auto space-y-1">
          {sessions.map(s => (
            <button key={s.id} onClick={() => onSelect(s.id)}
              className="w-full text-left px-3 py-2 rounded text-[11px] text-neutral-300 hover:bg-bg-700 flex items-center gap-2 border border-surface-border">
              <FolderOpen size={11} className="text-accent shrink-0" /> <span className="truncate">{s.name}</span>
            </button>
          ))}
        </div>
        <div className="flex gap-1 pt-2 border-t border-surface-border">
          <input type="text" value={newName} onChange={(e) => setNewName(e.target.value)}
            placeholder="New session name..." className="input-field text-[10px] flex-1" onKeyDown={(e) => { if (e.key === 'Enter' && newName.trim()) onCreateNew(newName.trim()); }} />
          <button onClick={() => { if (newName.trim()) onCreateNew(newName.trim()); }}
            className="btn btn-accent text-[10px] px-3 disabled:opacity-40" disabled={!newName.trim()}>
            <Plus size={11} />
          </button>
        </div>
        <button onClick={onCancel} className="w-full text-[10px] text-neutral-600 hover:text-neutral-400 py-1">Cancel</button>
      </div>
    </div>
  );
}

// ── Package viewer overlay for generated packages ──
function PackageViewer({ pkg, onClose, onSendTo }) {
  const [selectedNode, setSelectedNode] = useState('root');
  const [showVideo, setShowVideo] = useState(false);
  const [videoIdx, setVideoIdx] = useState(0);
  const [showSendMenu, setShowSendMenu] = useState(false);
  const [zoom, setZoom] = useState(1);

  const currentNode = selectedNode === 'root' ? pkg.root : pkg.variants?.find(v => v.id === selectedNode);
  const meta = selectedNode === 'root' ? (currentNode?.metadata || {}) : (currentNode?.settings || {});
  const rootMeta = pkg.root?.metadata || {};
  const nodeVideos = currentNode?.videos || [];
  const currentVideo = nodeVideos[videoIdx];

  const handleWheel = (e) => { e.preventDefault(); setZoom(z => Math.max(0.5, Math.min(5, z + (e.deltaY > 0 ? -0.15 : 0.15)))); };

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center" style={{ WebkitAppRegion: 'no-drag' }}>
      <div className="absolute inset-0 bg-black/80 backdrop-blur-sm" onClick={onClose} />
      <div className="relative flex w-[92%] h-[88%] max-w-[1400px] rounded-xl overflow-hidden border border-surface-border shadow-2xl bg-bg-900">
        {/* Left: Visual */}
        <div className="flex-1 flex flex-col min-w-0">
          <div className="flex-1 flex items-center justify-center overflow-hidden p-4" onWheel={handleWheel}>
            {showVideo && currentVideo ? (
              <video src={currentVideo.videoUrl} className="max-h-full max-w-full rounded-lg transition-transform duration-150" style={{ transform: `scale(${zoom})` }} autoPlay loop muted controls onDoubleClick={() => setZoom(z => z === 1 ? 2 : 1)} />
            ) : (
              <img src={currentNode?.preview} className="max-h-full max-w-full object-contain rounded transition-transform duration-150" style={{ transform: `scale(${zoom})` }} onDoubleClick={() => setZoom(z => z === 1 ? 2 : 1)} />
            )}
          </div>
          <div className="flex items-center justify-between px-4 py-2 bg-bg-800/80 border-t border-surface-border">
            <div className="flex items-center gap-2">
              {nodeVideos.length > 0 && (
                <div className="flex items-center gap-1 bg-bg-700 rounded-full px-1 py-0.5">
                  <button onClick={() => setShowVideo(false)} className={`text-[10px] px-2 py-0.5 rounded-full ${!showVideo ? 'bg-accent text-white' : 'text-neutral-500'}`}>Image</button>
                  <button onClick={() => { setShowVideo(true); setVideoIdx(nodeVideos.length - 1); }} className={`text-[10px] px-2 py-0.5 rounded-full ${showVideo ? 'bg-emerald-500 text-white' : 'text-neutral-500'}`}>
                    <Film size={9} /> {nodeVideos.length > 1 ? `${videoIdx + 1}/${nodeVideos.length}` : 'Video'}
                  </button>
                  {nodeVideos.length > 1 && showVideo && <>
                    <button onClick={() => setVideoIdx(Math.max(0, videoIdx - 1))} disabled={videoIdx <= 0} className="text-[10px] px-1 text-neutral-400 disabled:opacity-30">◀</button>
                    <button onClick={() => setVideoIdx(Math.min(nodeVideos.length - 1, videoIdx + 1))} disabled={videoIdx >= nodeVideos.length - 1} className="text-[10px] px-1 text-neutral-400 disabled:opacity-30">▶</button>
                  </>}
                </div>
              )}
            </div>
            <div className="flex items-center gap-2">
              <div className="relative">
                <button onClick={() => setShowSendMenu(!showSendMenu)} className="btn btn-ghost text-[10px] px-2 py-1 border border-accent/30 text-accent flex items-center gap-1"><ArrowRight size={11} /> Send to...</button>
                {showSendMenu && (
                  <div className="absolute bottom-full right-0 mb-1 bg-bg-800 border border-surface-border rounded-lg shadow-xl py-1 min-w-[180px] z-10">
                    {showVideo && currentVideo ? (
                      <button onClick={() => { onSendTo({ type: 'video', path: currentVideo.path }); onClose(); }} className="w-full text-left px-3 py-1.5 text-[11px] text-neutral-300 hover:bg-bg-700 flex items-center gap-2"><Film size={11} className="text-emerald-400" /> Extend Video</button>
                    ) : (<>
                      <button onClick={() => { onSendTo({ type: 'image', preview: currentNode?.preview, prompt: meta?.prompt || rootMeta?.prompt }); onClose(); }} className="w-full text-left px-3 py-1.5 text-[11px] text-neutral-300 hover:bg-bg-700 flex items-center gap-2"><Film size={11} className="text-accent" /> Long Video</button>
                      <button onClick={() => { onSendTo({ type: 'animate', preview: currentNode?.preview, prompt: meta?.prompt || rootMeta?.prompt }); onClose(); }} className="w-full text-left px-3 py-1.5 text-[11px] text-neutral-300 hover:bg-bg-700 flex items-center gap-2"><Play size={11} className="text-emerald-400" /> Animate Image</button>
                      <button onClick={() => { onSendTo({ type: 'editor', preview: currentNode?.preview, prompt: meta?.prompt || rootMeta?.prompt }); onClose(); }} className="w-full text-left px-3 py-1.5 text-[11px] text-neutral-300 hover:bg-bg-700 flex items-center gap-2"><Pencil size={11} className="text-purple-400" /> Editor</button>
                    </>)}
                  </div>
                )}
              </div>
              <button onClick={onClose} className="text-neutral-500 hover:text-white"><X size={16} /></button>
            </div>
          </div>
        </div>
        {/* Right: Tree + Details */}
        <div className="w-72 shrink-0 flex flex-col border-l border-surface-border bg-bg-800 overflow-hidden">
          <div className="px-4 py-2.5 border-b border-surface-border shrink-0">
            <span className="text-[11px] text-neutral-400">Package</span>
            {pkg.sessionName && <span className="text-[9px] text-neutral-600 ml-2">from {pkg.sessionName}</span>}
          </div>
          <div className="flex-1 overflow-y-auto">
            {/* Tree */}
            <div className="p-3 border-b border-surface-border">
              <span className="text-[9px] text-neutral-600 uppercase tracking-wider block mb-2">Lineage</span>
              <button onClick={() => { setSelectedNode('root'); setShowVideo(false); setVideoIdx(0); }}
                className={`w-full text-left text-[10px] px-2 py-1.5 rounded flex items-center gap-2 mb-0.5 ${selectedNode === 'root' ? 'bg-accent/10 text-accent border border-accent/30' : 'text-neutral-400 hover:bg-bg-700'}`}>
                <ImageIcon size={10} /> <span className="flex-1 truncate">Original</span>
                {pkg.root?.videos?.length > 0 && <span className="text-[8px] text-emerald-400">▶{pkg.root.videos.length}</span>}
              </button>
              {(pkg.variants || []).map(v => (
                <div key={v.id} className="flex items-center gap-0.5 ml-3">
                  <span className="text-neutral-700 text-[10px]">├</span>
                  <button onClick={() => { setSelectedNode(v.id); setShowVideo(false); setVideoIdx(0); }}
                    className={`flex-1 text-left text-[10px] px-2 py-1 rounded flex items-center gap-1.5 ${selectedNode === v.id ? 'bg-accent/10 text-accent border border-accent/30' : 'text-neutral-500 hover:bg-bg-700'}`}>
                    {v.type === 'hires' ? <Sparkles size={9} /> : <Pencil size={9} />}
                    <span className="flex-1 truncate">{v.label}</span>
                    {v.videos?.length > 0 && <span className="text-[8px] text-emerald-400">▶{v.videos.length}</span>}
                  </button>
                </div>
              ))}
            </div>
            {/* Details */}
            <div className="p-4 space-y-2">
              {(meta?.prompt || rootMeta?.prompt) && <p className="text-[10px] text-neutral-300 leading-relaxed">{meta?.prompt || rootMeta?.prompt}</p>}
              {currentNode?.settings?.editPrompt && <p className="text-[10px] text-purple-400 bg-purple-500/10 rounded p-2 mt-1">Edit: {currentNode.settings.editPrompt}</p>}
              {selectedNode !== 'root' && meta?.sourcePrompt && meta.sourcePrompt !== (meta?.prompt || rootMeta?.prompt) && (
                <p className="text-[9px] text-neutral-500 mt-1">Source: {meta.sourcePrompt}</p>
              )}
              <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[10px]">
                {(meta?.width || rootMeta?.width) && <><span className="text-neutral-600">Size</span><span className="text-neutral-400">{(meta?.width || rootMeta?.width)}×{(meta?.height || rootMeta?.height)}</span></>}
                {(meta?.seed > 0 || rootMeta?.seed > 0) && <><span className="text-neutral-600">Seed</span><span className="text-neutral-400">{meta?.seed || rootMeta?.seed}</span></>}
                {(meta?.steps || rootMeta?.steps) && <><span className="text-neutral-600">Steps</span><span className="text-neutral-400">{meta?.steps || rootMeta?.steps}</span></>}
              </div>
              {showVideo && currentVideo?.vlmPrompt && (
                <div className="pt-2 border-t border-surface-border/50">
                  <span className="text-[9px] text-emerald-400 uppercase tracking-wider">VLM Prompt</span>
                  <p className="text-[10px] text-emerald-300 bg-emerald-500/10 rounded p-1.5 mt-1 line-clamp-4">{currentVideo.vlmPrompt}</p>
                </div>
              )}
              {showVideo && currentVideo?.finalPrompt && !currentVideo?.vlmPrompt && (
                <div className="pt-2 border-t border-surface-border/50">
                  <span className="text-[9px] text-neutral-600">Prompt</span>
                  <p className="text-[10px] text-neutral-300 bg-bg-700 rounded p-1.5 mt-1">{currentVideo.finalPrompt}</p>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function GalleryPage() {
  const vs = useStore();
  const ss = useSessionStore();

  const [innerTab, setInnerTab] = useState('generated');
  const [allPackages, setAllPackages] = useState([]);
  const [loading, setLoading] = useState(false);

  // Imported state
  const [categories, setCategories] = useState([]);
  const [selectedCat, setSelectedCat] = useState(null);
  const [selectedSubcat, setSelectedSubcat] = useState(null);
  const [expandedCats, setExpandedCats] = useState(new Set());
  const [files, setFiles] = useState([]);

  // Viewer
  const [viewItem, setViewItem] = useState(null);
  const [viewPkg, setViewPkg] = useState(null);

  // Session picker
  const [sessionPicker, setSessionPicker] = useState(null);
  const [importing, setImporting] = useState(false);
  const [directorProjects, setDirectorProjects] = useState([]);
  const [directorLoading, setDirectorLoading] = useState(false);

  // ── Load generated packages ──
  const loadGenerated = useCallback(async () => {
    if (!window.electronAPI) return;
    setLoading(true);
    try { setAllPackages(await window.electronAPI.galleryListAllPackages()); } catch (e) { console.error(e); }
    setLoading(false);
  }, []);

  // ── Load imports ──
  const loadImports = useCallback(async () => {
    if (!window.electronAPI) return;
    try { setCategories(await window.electronAPI.galleryListImports()); } catch (e) { console.error(e); }
  }, []);

  const loadDirectorProjects = useCallback(async () => {
    if (!window.electronAPI) return;
    setDirectorLoading(true);
    try {
      const projects = await window.electronAPI.directorListProjects();
      // Load video URLs for each project
      const withUrls = [];
      for (const p of projects) {
        if (p.hasVideo) {
          const videoUrl = await window.electronAPI.directorGetVideoUrl(p.id);
          withUrls.push({ ...p, videoUrl });
        } else {
          withUrls.push(p);
        }
      }
      setDirectorProjects(withUrls);
    } catch { setDirectorProjects([]); }
    setDirectorLoading(false);
  }, []);

  useEffect(() => {
    if (innerTab === 'generated') loadGenerated();
    else if (innerTab === 'director') loadDirectorProjects();
    else loadImports();
  }, [innerTab]);

  // Load files when selecting category
  const selectCategory = async (cat, subcat = null) => {
    setSelectedCat(cat); setSelectedSubcat(subcat);
    const targetPath = subcat ? subcat.path : cat.path;
    if (!window.electronAPI) return;
    const f = await window.electronAPI.galleryListFiles(targetPath);
    setFiles(f);
  };

  // ── Import folder ──
  const handleImport = async () => {
    if (!window.electronAPI) return;
    setImporting(true);
    try {
      const result = await window.electronAPI.galleryImportFolder();
      if (result) await loadImports();
    } catch (e) { console.error('Import failed:', e); }
    setImporting(false);
  };

  // ── Delete category ──
  const handleDeleteCategory = async (catPath) => {
    if (!window.electronAPI) return;
    await window.electronAPI.galleryDeleteImport(catPath);
    if (selectedCat?.path === catPath) { setSelectedCat(null); setSelectedSubcat(null); setFiles([]); }
    await loadImports();
  };

  // ── Send imported media to a tab (with session picker) ──
  const handleSendTo = async (item, dest) => {
    // Load sessions for picker
    if (!window.electronAPI) return;
    const sessions = await window.electronAPI.sessionList();
    setSessionPicker({ item, dest, sessions });
  };

  const handleSessionSelected = async (sessionId) => {
    const { item, dest } = sessionPicker;
    setSessionPicker(null);

    try {
      if (item.isVideo) {
        // Video — extract first frame, create package, copy to ComfyUI
        const fn = await window.electronAPI.copyToComfyUIInput(item.path);

        // Extract first frame using hidden video+canvas
        let frameBlob = null;
        try {
          frameBlob = await new Promise((resolve, reject) => {
            const video = document.createElement('video');
            video.muted = true; video.preload = 'auto';
            video.onloadeddata = () => {
              video.currentTime = 0.1; // slight offset to avoid black frame
            };
            video.onseeked = () => {
              try {
                const canvas = document.createElement('canvas');
                canvas.width = video.videoWidth; canvas.height = video.videoHeight;
                canvas.getContext('2d').drawImage(video, 0, 0);
                canvas.toBlob(b => { video.remove(); canvas.remove(); resolve(b); }, 'image/png');
              } catch (e) { reject(e); }
            };
            video.onerror = reject;
            video.src = item.preview;
            setTimeout(() => reject(new Error('Frame extraction timeout')), 10000);
          });
        } catch (e) { console.warn('Frame extraction failed:', e); }

        // Create package with first frame (or placeholder)
        if (frameBlob) {
          const uploaded = await comfy.uploadImage(new File([frameBlob], 'video_frame.png', { type: 'image/png' }));
          const pkg = await window.electronAPI.pkgCreate({
            sessionId, comfyFilename: uploaded.name, comfySubfolder: '', comfyType: 'input',
            metadata: { prompt: '', source: 'import_video', importedFrom: item.path },
          });
          // Copy video into the package
          await window.electronAPI.pkgAddVideo({
            sessionId, pkgId: pkg.id, nodeId: 'root',
            comfyFilename: fn, comfySubfolder: '', comfyType: 'input',
            videoMeta: { source: 'import', importedFrom: item.path },
          });
        }

        vs.setVideoWorkflow('extend'); vs.setVideoName(fn);
        vs.setVideoPreview(`http://127.0.0.1:8188/view?filename=${encodeURIComponent(fn)}&type=input`);
        
      } else {
        // Image — upload to ComfyUI + create package in chosen session
        const resp = await fetch(item.preview);
        const blob = await resp.blob();
        const uploaded = await comfy.uploadImage(new File([blob], item.filename, { type: 'image/png' }));

        // Create package in the session
        await window.electronAPI.pkgCreate({
          sessionId, comfyFilename: uploaded.name, comfySubfolder: '', comfyType: 'input',
          metadata: { prompt: '', source: 'import', importedFrom: item.path },
        });

        if (dest === 'longvideo' || dest === 'animate') {
          vs.setImageName(uploaded.name); vs.setImagePreview(item.preview);

        } else if (dest === 'editor') {
          
        }
      }
    } catch (err) { console.error('Send failed:', err); }
  };

  const handleCreateNewSession = async (name) => {
    if (!window.electronAPI) return;
    const meta = await window.electronAPI.sessionCreate(name);
    await handleSessionSelected(meta.id);
  };

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-2 border-b border-surface-border shrink-0">
        <FolderOpen size={16} className="text-accent" />
        <span className="text-sm font-semibold text-neutral-200">Gallery</span>
        <div className="flex items-center bg-bg-700 rounded-md p-0.5 ml-3">
          <button onClick={() => setInnerTab('generated')}
            className={`px-3 py-1 rounded text-[11px] font-medium transition-colors ${innerTab === 'generated' ? 'bg-accent text-white' : 'text-neutral-500 hover:text-neutral-300'}`}>
            Generated
          </button>
          <button onClick={() => setInnerTab('imported')}
            className={`px-3 py-1 rounded text-[11px] font-medium transition-colors ${innerTab === 'imported' ? 'bg-accent text-white' : 'text-neutral-500 hover:text-neutral-300'}`}>
            Imported
          </button>
          <button onClick={() => setInnerTab('director')}
            className={`px-3 py-1 rounded text-[11px] font-medium transition-colors ${innerTab === 'director' ? 'bg-amber-500 text-white' : 'text-neutral-500 hover:text-neutral-300'}`}>
            Director
          </button>
        </div>
        <div className="flex-1" />
        {innerTab === 'generated' && (
          <button onClick={loadGenerated} className="btn btn-ghost text-[10px] p-1.5"><RefreshCw size={12} /></button>
        )}
        {innerTab === 'director' && (
          <button onClick={loadDirectorProjects} className="btn btn-ghost text-[10px] p-1.5"><RefreshCw size={12} /></button>
        )}
        {innerTab === 'imported' && (
          <button onClick={handleImport} disabled={importing} className="btn btn-accent text-[10px] px-3 py-1 flex items-center gap-1 disabled:opacity-40">
            {importing ? <Loader2 size={11} className="animate-spin" /> : <Upload size={11} />} {importing ? 'Importing...' : 'Import Folder'}</button>
        )}
      </div>

      {/* ── GENERATED TAB ── */}
      {innerTab === 'generated' && (
        <div className="flex-1 overflow-y-auto p-4">
          {loading ? (
            <div className="flex items-center justify-center h-full"><Loader2 size={24} className="animate-spin text-accent" /></div>
          ) : allPackages.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-neutral-600">
              <ImageIcon size={40} className="mb-3 opacity-40" />
              <p className="text-sm">No generated media yet</p>
              <p className="text-[10px] text-neutral-700 mt-1">Generate images in Studio to see them here</p>
            </div>
          ) : (
            <div className="columns-2 lg:columns-3 xl:columns-4 gap-3 space-y-3">
              {allPackages.map(pkg => {
                const root = pkg.root;
                const totalVideos = (root?.videos?.length || 0) + (pkg.variants || []).reduce((s, v) => s + (v.videos?.length || 0), 0);
                const totalVariants = (pkg.variants || []).length;
                return (
                  <div key={pkg.id} className="group relative bg-bg-800 rounded-lg overflow-hidden border border-surface-border break-inside-avoid cursor-pointer"
                    onClick={() => setViewPkg(pkg)}>
                    <img src={root?.preview || root?.thumb} alt={pkg.id} className="w-full h-auto block" loading="lazy" />
                    <div className="absolute inset-0 bg-black/0 group-hover:bg-black/40 transition-all" />
                    {totalVariants > 0 && <div className="absolute top-1.5 right-1.5 text-[9px] bg-purple-500/80 text-white rounded px-1 py-0.5">{totalVariants} variant{totalVariants > 1 ? 's' : ''}</div>}
                    {totalVideos > 0 && <div className="absolute top-1.5 right-10 text-[9px] bg-emerald-500/80 text-white rounded px-1 py-0.5">▶ {totalVideos}</div>}
                    {pkg.sessionName && <div className="absolute bottom-1.5 left-1.5 text-[8px] bg-bg-900/70 text-neutral-500 rounded px-1 py-0.5 opacity-0 group-hover:opacity-100">{pkg.sessionName}</div>}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ── IMPORTED TAB ── */}
      {innerTab === 'imported' && (
        <div className="flex-1 flex overflow-hidden">
          {/* Sidebar — categories */}
          <div className="w-56 shrink-0 border-r border-surface-border overflow-y-auto p-3 space-y-1">
            {categories.length === 0 ? (
              <div className="text-center py-8">
                <FolderOpen size={24} className="mx-auto mb-2 text-neutral-700" />
                <p className="text-[10px] text-neutral-600">No imports yet</p>
                <button onClick={handleImport} className="btn btn-ghost text-[10px] mt-2 border border-dashed border-surface-border px-3 py-1.5 flex items-center gap-1 mx-auto">
                  <Upload size={10} /> Import Folder
                </button>
              </div>
            ) : categories.map(cat => {
              const isExpanded = expandedCats.has(cat.name);
              const hasSubs = cat.subcategories.length > 0;
              const toggleExpand = (e) => { e.stopPropagation(); setExpandedCats(s => { const n = new Set(s); if (n.has(cat.name)) n.delete(cat.name); else n.add(cat.name); return n; }); };
              return (
              <div key={cat.name}>
                <div className={`flex items-center gap-1 px-2 py-1.5 rounded cursor-pointer group/cat ${selectedCat?.name === cat.name && !selectedSubcat ? 'bg-accent/10 text-accent' : 'text-neutral-400 hover:bg-bg-700'}`}>
                  {hasSubs && (
                    <button onClick={toggleExpand} className="shrink-0 text-neutral-600 hover:text-neutral-400">
                      <ChevronRight size={10} className={`transition-transform ${isExpanded ? 'rotate-90' : ''}`} />
                    </button>
                  )}
                  <button onClick={() => { selectCategory(cat); if (hasSubs && !isExpanded) toggleExpand({ stopPropagation: () => {} }); }} className="flex-1 flex items-center gap-1.5 text-left min-w-0">
                    <FolderOpen size={11} className="shrink-0" />
                    <span className="text-[10px] truncate flex-1">{cat.name}</span>
                    <span className="text-[8px] text-neutral-600">{cat.directCount + cat.subcategories.reduce((s, sc) => s + sc.count, 0)}</span>
                  </button>
                  <button onClick={() => { if (confirm(`Delete "${cat.name}" and all its media?`)) handleDeleteCategory(cat.path); }}
                    className="text-neutral-700 hover:text-red-400 opacity-0 group-hover/cat:opacity-100 shrink-0"><Trash2 size={9} /></button>
                </div>
                {hasSubs && isExpanded && cat.subcategories.map(sub => (
                  <button key={sub.name} onClick={() => selectCategory(cat, sub)}
                    className={`w-full flex items-center gap-1.5 px-2 py-1 ml-5 rounded text-[10px] ${selectedSubcat?.name === sub.name ? 'bg-accent/10 text-accent' : 'text-neutral-500 hover:bg-bg-700'}`}>
                    <FolderOpen size={9} className="shrink-0 text-neutral-600" />
                    <span className="truncate flex-1">{sub.name}</span>
                    <span className="text-[8px] text-neutral-600">{sub.count}</span>
                  </button>
                ))}
              </div>
              );
            })}
          </div>

          {/* Grid */}
          <div className="flex-1 overflow-y-auto p-4">
            {!selectedCat ? (
              <div className="flex flex-col items-center justify-center h-full text-neutral-600">
                <FolderOpen size={40} className="mb-3 opacity-40" />
                <p className="text-sm">Select a category to browse</p>
              </div>
            ) : files.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full text-neutral-600">
                <p className="text-sm">No media in this folder</p>
                <p className="text-[10px] text-neutral-700 mt-1">Try a subcategory</p>
              </div>
            ) : (
              <div className="columns-2 lg:columns-3 xl:columns-4 gap-3 space-y-3">
                {files.map(f => (
                  <div key={f.path} className="group relative bg-bg-800 rounded-lg overflow-hidden border border-surface-border break-inside-avoid cursor-pointer"
                    onClick={() => setViewItem(f)}>
                    {f.isVideo ? (
                      <video src={f.preview} className="w-full h-auto block" muted preload="metadata" />
                    ) : (
                      <img src={f.preview} alt={f.filename} className="w-full h-auto block" loading="lazy" />
                    )}
                    <div className="absolute inset-0 bg-black/0 group-hover:bg-black/40 transition-all flex items-end justify-center opacity-0 group-hover:opacity-100">
                      <div className="flex gap-1.5 pb-3" onClick={(e) => e.stopPropagation()}>
                        <button onClick={() => handleSendTo(f, f.isVideo ? 'longvideo' : 'animate')}
                          className="bg-bg-800/90 hover:bg-accent text-neutral-300 hover:text-white px-2.5 py-1.5 rounded-md text-[11px] flex items-center gap-1">
                          <ArrowRight size={12} /> Send
                        </button>
                      </div>
                    </div>
                    {f.isVideo && <div className="absolute top-1.5 right-1.5 text-[9px] bg-emerald-500/80 text-white rounded px-1 py-0.5">▶</div>}
                    <div className="absolute bottom-1.5 left-1.5 text-[8px] bg-bg-900/70 text-neutral-500 rounded px-1 py-0.5 opacity-0 group-hover:opacity-100 truncate max-w-[80%]">{f.filename}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── DIRECTOR TAB ── */}
      {innerTab === 'director' && (
        <div className="flex-1 overflow-y-auto p-4">
          {directorLoading ? (
            <div className="flex items-center justify-center h-40"><Loader2 size={20} className="animate-spin text-accent" /></div>
          ) : directorProjects.length === 0 ? (
            <div className="text-center py-16">
              <Film size={40} className="mx-auto mb-3 text-neutral-700" />
              <p className="text-[11px] text-neutral-500">No Director projects yet</p>
              <p className="text-[9px] text-neutral-600 mt-1">Run the AI Director to generate videos</p>
            </div>
          ) : (
            <div className="grid grid-cols-3 gap-4">
              {directorProjects.map(p => (
                <div key={p.id} className="bg-bg-800 rounded-xl border border-surface-border overflow-hidden group hover:border-accent/30 transition-colors">
                  {/* Video preview */}
                  <div className="aspect-video bg-black relative">
                    {p.videoUrl ? (
                      <video src={p.videoUrl} className="w-full h-full object-cover" muted preload="metadata"
                        onMouseEnter={e => e.target.play()} onMouseLeave={e => { e.target.pause(); e.target.currentTime = 0; }} />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center"><Film size={24} className="text-neutral-700" /></div>
                    )}
                    {/* Badges */}
                    <div className="absolute top-1.5 left-1.5 flex gap-1">
                      {p.hasLatent && <span className="text-[7px] bg-emerald-500/80 text-white px-1.5 py-0.5 rounded font-semibold">Latent</span>}
                      {p.hasVideo && <span className="text-[7px] bg-accent/80 text-white px-1.5 py-0.5 rounded font-semibold">Video</span>}
                      <span className={`text-[7px] px-1.5 py-0.5 rounded font-semibold ${
                        p.meta?.engine === 'ltx23' ? 'bg-cyan-500/80 text-white' : 'bg-amber-500/80 text-white'
                      }`}>{p.meta?.engine === 'ltx23' ? 'LTX' : 'Wan'}</span>
                    </div>
                    {p.meta?.completedSegments && (
                      <span className="absolute bottom-1.5 right-1.5 text-[8px] bg-black/70 text-neutral-300 px-1.5 py-0.5 rounded font-mono">
                        {p.meta.completedSegments} segs
                      </span>
                    )}
                  </div>
                  {/* Info */}
                  <div className="px-3 py-2.5">
                    <p className="text-[10px] text-neutral-300 leading-relaxed line-clamp-2">{p.meta?.intent || p.id}</p>
                    <div className="flex items-center gap-2 mt-1.5 text-[8px] text-neutral-500">
                      {p.meta?.targetLength && <span>{p.meta.targetLength}s</span>}
                      {p.meta?.resolution && <span className="capitalize">{p.meta.resolution}</span>}
                      {p.meta?.videoPreset && <span className={p.meta.videoPreset === 'fast' ? 'text-amber-500' : 'text-violet-400'}>
                        {p.meta.videoPreset === 'fast' ? '⚡' : '🎨'} {p.meta.videoPreset}
                      </span>}
                      {p.videoSize > 0 && <span>{(p.videoSize / 1024 / 1024).toFixed(1)}MB</span>}
                    </div>
                    <p className="text-[8px] text-neutral-600 mt-1">
                      {p.meta?.updatedAt ? new Date(p.meta.updatedAt).toLocaleString() : ''}
                    </p>
                    {/* Actions */}
                    {p.hasVideo && (
                      <div className="flex gap-1.5 mt-2">
                        {p.videoUrl && (
                          <button onClick={async () => {
                            if (!window.electronAPI) return;
                            await window.electronAPI.saveFileAs?.({
                              sourcePath: p.projDir + '/' + p.videoFile,
                              defaultName: `director_${p.id}.mp4`,
                              filters: [{ name: 'Video', extensions: ['mp4'] }],
                            });
                          }} className="flex items-center gap-1 text-[8px] text-neutral-500 hover:text-neutral-300 px-1.5 py-0.5 bg-bg-700 rounded">
                            <Download size={8} /> Save
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Media Viewer Overlay (imported) ── */}
      {viewItem && (
        <MediaViewer
          item={viewItem}
          onClose={() => setViewItem(null)}
          onSendTo={(dest) => handleSendTo(viewItem, dest)}
        />
      )}

      {/* ── Package Viewer Overlay (generated) ── */}
      {viewPkg && (
        <PackageViewer
          pkg={viewPkg}
          onClose={() => setViewPkg(null)}
          onSendTo={async (info) => {
            setViewPkg(null);
            try {
              if (info.type === 'video' && info.path) {
                const fn = await window.electronAPI.copyToComfyUIInput(info.path);
                vs.setVideoWorkflow('extend'); vs.setVideoName(fn);
                vs.setVideoPreview(`http://127.0.0.1:8188/view?filename=${encodeURIComponent(fn)}&type=input`);
                
              } else if (info.type === 'image' || info.type === 'animate' || info.type === 'editor') {
                const resp = await fetch(info.preview);
                const blob = await resp.blob();
                const uploaded = await comfy.uploadImage(new File([blob], 'gallery.png', { type: 'image/png' }));
                if (info.type === 'image' || info.type === 'animate') {
                  vs.setImageName(uploaded.name); vs.setImagePreview(info.preview);
                  if (info.prompt) vs.setUserPrompt(info.prompt);
                  
                } else {
                  
                }
              }
            } catch (err) { console.error('Send failed:', err); }
          }}
        />
      )}

      {/* ── Import Loading Overlay ── */}
      {importing && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" style={{ WebkitAppRegion: 'no-drag' }}>
          <div className="bg-bg-800 border border-surface-border rounded-xl shadow-2xl p-6 flex flex-col items-center gap-4 w-72">
            <Loader2 size={32} className="animate-spin text-accent" />
            <div className="text-center">
              <p className="text-sm font-medium text-neutral-200">Importing Folder</p>
              <p className="text-[10px] text-neutral-500 mt-1">Copying files to app storage...</p>
              <p className="text-[9px] text-neutral-600 mt-0.5">Large folders may take a while</p>
            </div>
            <div className="w-full h-1 bg-bg-700 rounded-full overflow-hidden">
              <div className="h-full bg-accent rounded-full animate-pulse" style={{ width: '100%' }} />
            </div>
          </div>
        </div>
      )}

      {/* ── Session Picker Popup ── */}
      {sessionPicker && (
        <SessionPicker
          sessions={sessionPicker.sessions}
          onSelect={handleSessionSelected}
          onCreateNew={handleCreateNewSession}
          onCancel={() => setSessionPicker(null)}
        />
      )}
    </div>
  );
}
