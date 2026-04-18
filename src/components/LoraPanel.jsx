import React, { useState, useMemo } from 'react';
import useStore from '../lib/store';
import { X, Plus, Search, ChevronDown, ChevronRight, Trash2 } from 'lucide-react';

function LoraItem({ lora, onRemove, onUpdate }) {
  const isEnabled = lora.enabled !== false; // default true for legacy

  return (
    <div className={`bg-bg-700 rounded-md p-2 group ${!isEnabled ? 'opacity-40' : ''}`}>
      <div className="flex items-center justify-between mb-1">
        {/* On/off toggle */}
        <button
          onClick={() => onUpdate(lora.id, { enabled: !isEnabled })}
          className={`w-7 h-4 rounded-full relative transition-colors shrink-0 mr-2 ${
            isEnabled ? 'bg-accent' : 'bg-neutral-700'
          }`}
          title={isEnabled ? 'Disable' : 'Enable'}
        >
          <div
            className={`w-3 h-3 bg-white rounded-full absolute top-0.5 transition-all ${
              isEnabled ? 'left-3.5' : 'left-0.5'
            }`}
          />
        </button>
        <span
          className="text-[11px] text-neutral-300 truncate flex-1 mr-2"
          title={lora.name}
        >
          {lora.name.replace('.safetensors', '')}
        </span>
        <button
          onClick={() => onRemove(lora.id)}
          className="opacity-0 group-hover:opacity-100 text-neutral-600 hover:text-red-400 transition-all"
        >
          <X size={13} />
        </button>
      </div>
      {isEnabled && (
        <div className="flex items-center gap-2">
          <input
            type="range"
            min="0"
            max="2"
            step="0.05"
            value={lora.strength_model}
            onChange={(e) => onUpdate(lora.id, { strength_model: parseFloat(e.target.value) })}
            className="flex-1"
          />
          <input
            type="number"
            min="0"
            max="2"
            step="0.05"
            value={lora.strength_model}
            onChange={(e) => onUpdate(lora.id, { strength_model: parseFloat(e.target.value) || 0 })}
            className="w-12 bg-bg-800 border border-surface-border rounded text-[10px] text-neutral-400 text-center py-0.5 outline-none focus:border-accent tabular-nums"
          />
        </div>
      )}
    </div>
  );
}

function LoraDropdown({ availableLoras, onAdd, onClose }) {
  const [search, setSearch] = useState('');

  const filtered = useMemo(() => {
    if (!search) return availableLoras;
    const q = search.toLowerCase();
    return availableLoras.filter((l) => l.name.toLowerCase().includes(q));
  }, [search, availableLoras]);

  return (
    <div className="bg-bg-800 border border-surface-border rounded-md overflow-hidden animate-in">
      <div className="p-1.5 border-b border-surface-border flex items-center gap-1.5">
        <Search size={11} className="text-neutral-500 shrink-0" />
        <input
          type="text"
          placeholder="Search LoRAs..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="bg-transparent text-xs text-neutral-200 outline-none flex-1 min-w-0"
          autoFocus
        />
        <button onClick={onClose} className="text-neutral-600 hover:text-neutral-300">
          <X size={12} />
        </button>
      </div>
      <div className="max-h-48 overflow-y-auto">
        {filtered.length === 0 ? (
          <div className="text-[11px] text-neutral-600 p-3 text-center">
            {availableLoras.length === 0
              ? 'No LoRAs found — set folder path in Settings'
              : 'No matches'}
          </div>
        ) : (
          filtered.map((l) => (
            <button
              key={l.path}
              onClick={() => {
                onAdd({ name: l.path });
                onClose();
              }}
              className="w-full text-left text-[11px] text-neutral-300 hover:bg-surface-light px-2.5 py-1.5 truncate block"
              title={l.path}
            >
              {l.name.replace('.safetensors', '')}
            </button>
          ))
        )}
      </div>
    </div>
  );
}

function LoraSection({ label, icon, loras, availableLoras, onAdd, onRemove, onUpdate, onClear }) {
  const [collapsed, setCollapsed] = useState(false);
  const [showDropdown, setShowDropdown] = useState(false);

  return (
    <div className="panel">
      {/* Header */}
      <div className="flex items-center justify-between">
        <button
          onClick={() => setCollapsed(!collapsed)}
          className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-neutral-400 hover:text-neutral-200 transition-colors"
        >
          {collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
          {icon} {label}
          {loras.length > 0 && (
            <span className="text-[10px] bg-accent/20 text-accent px-1.5 py-0.5 rounded-full font-normal normal-case">
              {loras.length}
            </span>
          )}
        </button>
        <div className="flex items-center gap-1">
          {loras.length > 0 && (
            <button
              onClick={onClear}
              className="text-neutral-600 hover:text-red-400 transition-colors p-0.5"
              title="Clear all"
            >
              <Trash2 size={12} />
            </button>
          )}
          <button
            onClick={() => setShowDropdown(!showDropdown)}
            className="btn btn-ghost text-[10px] flex items-center gap-0.5 px-1.5 py-0.5"
          >
            <Plus size={11} /> Add
          </button>
        </div>
      </div>

      {!collapsed && (
        <div className="mt-2 space-y-1.5">
          {/* Dropdown */}
          {showDropdown && (
            <LoraDropdown
              availableLoras={availableLoras}
              onAdd={onAdd}
              onClose={() => setShowDropdown(false)}
            />
          )}

          {/* Lora list — scrollable at 10+ */}
          {loras.length > 0 ? (
            <div
              className={`space-y-1.5 ${loras.length >= 10 ? 'max-h-[400px] overflow-y-auto pr-1' : ''}`}
            >
              {loras.map((lora) => (
                <LoraItem
                  key={lora.id}
                  lora={lora}
                  onRemove={onRemove}
                  onUpdate={onUpdate}
                />
              ))}
            </div>
          ) : (
            <div className="text-[11px] text-neutral-600 italic py-2 text-center">
              No LoRAs added
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function LoraPanel() {
  const store = useStore();

  // Convert ComfyUI API string array to objects the dropdown expects
  const comfyLoraObjects = useMemo(() =>
    (store.comfyLoras || []).map(p => {
      const ls = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
      return { name: ls > 0 ? p.substring(ls + 1) : p, path: p };
    }),
  [store.comfyLoras]);

  // Use ComfyUI API list, fall back to filesystem scan if API returned empty
  const lorasHigh = comfyLoraObjects.length > 0 ? comfyLoraObjects : store.availableLorasHigh;
  const lorasLow = comfyLoraObjects.length > 0 ? comfyLoraObjects : store.availableLorasLow;

  return (
    <div className="space-y-3">
      <LoraSection
        label="HIGH Pass"
        icon="⚡"
        loras={store.lorasHigh}
        availableLoras={lorasHigh}
        onAdd={store.addLoraHigh}
        onRemove={store.removeLoraHigh}
        onUpdate={store.updateLoraHigh}
        onClear={store.clearLorasHigh}
      />
      <LoraSection
        label="LOW Pass"
        icon="🔻"
        loras={store.lorasLow}
        availableLoras={lorasLow}
        onAdd={store.addLoraLow}
        onRemove={store.removeLoraLow}
        onUpdate={store.updateLoraLow}
        onClear={store.clearLorasLow}
      />
    </div>
  );
}
