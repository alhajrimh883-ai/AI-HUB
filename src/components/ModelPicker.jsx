import React, { useState, useMemo } from 'react';
import { Search, X, FolderOpen, ChevronDown } from 'lucide-react';

/**
 * ModelPicker — dropdown with folder filtering + search.
 * 
 * Props:
 *   models: string[]         — flat list of model paths from ComfyUI API
 *   value: string            — currently selected model path
 *   onChange: (path) => void — callback when selection changes
 *   placeholder: string      — placeholder text when nothing selected
 *   label: string            — optional label above the picker
 *   compact: boolean         — smaller variant for inline use
 */
export default function ModelPicker({ models, value, onChange, placeholder = '— workflow default —', label, compact }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [activeFolder, setActiveFolder] = useState('__all__');
  const [hoveredModel, setHoveredModel] = useState(null);

  // Helper: find last path separator (handles both / and \)
  const splitPath = (p) => {
    const ls = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
    return {
      folder: ls > 0 ? p.substring(0, ls) : '__root__',
      name: ls > 0 ? p.substring(ls + 1) : p,
    };
  };

  // Parse folders from model paths
  const { folders, modelsByFolder } = useMemo(() => {
    const folderSet = new Set();
    const byFolder = {};

    for (const m of (models || [])) {
      const { folder, name } = splitPath(m);
      folderSet.add(folder);
      if (!byFolder[folder]) byFolder[folder] = [];
      byFolder[folder].push({ path: m, name, folder });
    }

    const sorted = Array.from(folderSet).sort((a, b) => {
      if (a === '__root__') return -1;
      if (b === '__root__') return 1;
      return a.localeCompare(b);
    });
    return { folders: sorted, modelsByFolder: byFolder };
  }, [models]);

  // Filter by active folder + search
  const filtered = useMemo(() => {
    let list;
    if (activeFolder === '__all__') {
      list = (models || []).map(m => {
        const { folder, name } = splitPath(m);
        return { path: m, name, folder: folder === '__root__' ? '' : folder };
      });
    } else {
      list = modelsByFolder[activeFolder] || [];
    }
    if (search) {
      const q = search.toLowerCase();
      list = list.filter(m => m.name.toLowerCase().includes(q) || m.path.toLowerCase().includes(q));
    }
    return list;
  }, [models, activeFolder, search, modelsByFolder]);

  // Display name for current value
  const displayName = useMemo(() => {
    if (!value) return null;
    const { name } = splitPath(value);
    return name;
  }, [value]);

  const sz = compact ? 'text-[10px]' : 'text-[11px]';

  return (
    <div className="relative">
      {label && <label className="text-[10px] text-neutral-500 mb-0.5 block">{label}</label>}

      {/* Trigger */}
      <button onClick={() => setOpen(!open)}
        title={value || ''}
        className={`w-full flex items-center justify-between gap-1.5 bg-bg-700 border border-surface-border rounded-md px-2 py-1.5 ${sz} text-left hover:border-neutral-600 transition-colors`}>
        <span className={`truncate ${value ? 'text-neutral-200' : 'text-neutral-500'}`}>
          {displayName || placeholder}
        </span>
        <ChevronDown size={11} className="text-neutral-500 shrink-0" />
      </button>

      {/* Dropdown */}
      {open && (
        <div className="absolute top-full left-0 right-0 mt-1 bg-bg-800 border border-surface-border rounded-lg shadow-xl z-50 overflow-hidden"
          style={{ maxWidth: '400px', minWidth: '100%' }}>

          {/* Search */}
          <div className="p-1.5 border-b border-surface-border flex items-center gap-1.5">
            <Search size={11} className="text-neutral-500 shrink-0" />
            <input type="text" placeholder="Search models..." value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="bg-transparent text-xs text-neutral-200 outline-none flex-1" autoFocus />
            {(search || value) && (
              <button onClick={() => { onChange(''); setSearch(''); }}
                className="text-neutral-600 hover:text-neutral-300 text-[10px]">Clear</button>
            )}
            <button onClick={() => setOpen(false)} className="text-neutral-600 hover:text-neutral-300">
              <X size={12} />
            </button>
          </div>

          {/* Folder pills */}
          {folders.length > 1 && (
            <div className="flex flex-wrap gap-1 p-1.5 border-b border-surface-border bg-bg-900/50">
              <button onClick={() => setActiveFolder('__all__')}
                className={`text-[9px] px-1.5 py-0.5 rounded transition-colors ${activeFolder === '__all__' ? 'bg-accent text-white' : 'bg-bg-700 text-neutral-500 hover:text-neutral-300'}`}>
                All ({models?.length || 0})
              </button>
              {folders.map(f => (
                <button key={f} onClick={() => setActiveFolder(f)}
                  className={`text-[9px] px-1.5 py-0.5 rounded transition-colors flex items-center gap-0.5 ${activeFolder === f ? 'bg-accent text-white' : 'bg-bg-700 text-neutral-500 hover:text-neutral-300'}`}>
                  <FolderOpen size={8} />
                  {f === '__root__' ? 'root' : f}
                  <span className="opacity-60">({(modelsByFolder[f] || []).length})</span>
                </button>
              ))}
            </div>
          )}

          {/* Model list */}
          <div className="max-h-48 overflow-y-auto">
            {filtered.length === 0 ? (
              <div className="text-[11px] text-neutral-600 p-3 text-center">
                {(models || []).length === 0 ? 'No models found — is ComfyUI running?' : 'No matches'}
              </div>
            ) : (
              filtered.map(m => (
                <button key={m.path} onClick={() => { onChange(m.path); setOpen(false); setSearch(''); setHoveredModel(null); }}
                  onMouseEnter={() => setHoveredModel(m)}
                  onMouseLeave={() => setHoveredModel(null)}
                  className={`w-full text-left px-2 py-1.5 text-[11px] hover:bg-surface-light flex items-center gap-1.5 ${m.path === value ? 'bg-accent/10 text-accent' : 'text-neutral-300'}`}>
                  <span className="truncate flex-1">{m.name}</span>
                  {m.folder && <span className="text-[9px] text-neutral-600 shrink-0">{m.folder}</span>}
                </button>
              ))
            )}
          </div>

          {/* Hover preview bar — shows full name instantly */}
          {hoveredModel && (
            <div className="border-t border-surface-border bg-bg-900 px-2 py-1.5">
              <p className="text-[10px] text-neutral-400 break-all leading-relaxed">{hoveredModel.path}</p>
            </div>
          )}
        </div>
      )}

      {/* Click outside to close */}
      {open && <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />}
    </div>
  );
}
