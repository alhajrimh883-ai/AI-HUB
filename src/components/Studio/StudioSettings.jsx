import React, { useRef, useEffect } from 'react';
import useStudioSettings from '../../lib/studioStore';
import usePresetStore from '../../lib/presetStore';
import { STUDIO_RESOLUTIONS } from '../../lib/studioWorkflow';
import ModelPicker from '../ModelPicker';
import { X, Smartphone, Square, Monitor } from 'lucide-react';

function PresetDropdown({ type, mode, slot, label }) {
  const ps = usePresetStore();
  const presets = ps.getPresets(type, mode);
  const selectedId = ps.selectedPresets[mode]?.[slot] || '';
  return (
    <div>
      <span className="text-[10px] text-neutral-500 mb-0.5 block">{label}</span>
      <select value={selectedId} onChange={e => ps.setSelectedPreset(mode, slot, e.target.value)}
        className="input-field text-[10px] w-full truncate">
        <option value="">{type === 't2i' ? 'None (provide image)' : 'Select preset...'}</option>
        {presets.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>
    </div>
  );
}

export default function StudioSettings({ onClose }) {
  const ss = useStudioSettings();
  const ps = usePresetStore();
  const vlmEnabled = ps.getVlmConfig().enabled;
  const ref = useRef(null);
  const mode = ss.studioMode || 'fast';

  useEffect(() => {
    const handler = (e) => { if (ref.current && !ref.current.contains(e.target)) onClose(); };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);

  return (
    <div ref={ref} className="absolute bottom-full right-0 mb-2 w-72 bg-bg-800 border border-surface-border rounded-lg shadow-2xl z-50"
      style={{ maxHeight: 'calc(100vh - 120px)' }}>
      <div className="px-3 py-2 border-b border-surface-border flex items-center justify-between">
        <span className="text-[10px] font-bold uppercase tracking-widest text-neutral-500">Settings</span>
      </div>
      <div className="overflow-y-auto overflow-x-hidden" style={{ maxHeight: 'calc(100vh - 180px)' }}>
        <div className="p-3 space-y-3">

          {/* Mode */}
          <div>
            <span className="text-[10px] text-neutral-500 mb-1 block">Mode</span>
            <div className="flex gap-1">
              <button onClick={() => ss.setStudioMode?.('fast')}
                className={`btn flex-1 text-[10px] py-1 font-semibold ${mode === 'fast' ? 'bg-amber-500/20 text-amber-400 border border-amber-500/30' : 'btn-ghost border border-transparent'}`}>⚡ Fast</button>
              <button onClick={() => ss.setStudioMode?.('quality')}
                className={`btn flex-1 text-[10px] py-1 font-semibold ${mode === 'quality' ? 'bg-violet-500/20 text-violet-400 border border-violet-500/30' : 'btn-ghost border border-transparent'}`}>🎨 Quality</button>
            </div>
          </div>

          {/* Image Preset */}
          <PresetDropdown type="t2i" mode={mode} slot="t2i" label="Image Preset" />

          {/* Video Preset */}
          <PresetDropdown type="video" mode={mode} slot="video" label="Video Preset" />

          {/* Edit Preset */}
          <PresetDropdown type="edit" mode={mode} slot="edit" label="Edit Preset" />

          {/* HireFix Preset */}
          <PresetDropdown type="hirefix" mode={mode} slot="hirefix" label="HireFix Preset" />


          {/* Video Resolution */}
          <div>
            <span className="text-[10px] text-neutral-500 mb-1 block">Video Resolution</span>
            <div className="flex gap-1">
              <button onClick={() => ss.setAnimateHighRes(false)}
                className={`btn flex-1 text-[10px] py-1 ${!ss.animateHighRes ? 'bg-accent text-white' : 'btn-ghost'}`}>SD</button>
              <button onClick={() => ss.setAnimateHighRes(true)}
                className={`btn flex-1 text-[10px] py-1 ${ss.animateHighRes ? 'bg-accent text-white' : 'btn-ghost'}`}>HD</button>
            </div>
          </div>

          <div className="border-t border-surface-border" />

          {/* Image Resolution */}
          <div>
            <span className="text-[10px] text-neutral-500 mb-1 block">Image Resolution</span>
            <div className={`flex gap-1 ${ss.randomResolution ? 'opacity-40 pointer-events-none' : ''}`}>
              {Object.entries(STUDIO_RESOLUTIONS).map(([k, v]) => (
                <button key={k} onClick={() => ss.setStudioResolution(k)}
                  className={`btn flex-1 flex flex-col items-center gap-0.5 py-1.5 text-[9px] ${ss.studioResolution === k ? 'bg-accent text-white' : 'btn-ghost'}`}>
                  {k === 'portrait' ? <Smartphone size={10} /> : k === 'square' ? <Square size={10} /> : <Monitor size={10} />}
                  {v.w}×{v.h}
                </button>
              ))}
            </div>
            <div className="flex gap-2 mt-1.5">
              <label className="flex items-center gap-1 text-[9px] text-neutral-500 cursor-pointer">
                <input type="checkbox" checked={ss.randomResolution} onChange={() => ss.setRandomResolution(!ss.randomResolution)}
                  className="rounded border-surface-border w-3 h-3" /> Random
              </label>
              <label className="flex items-center gap-1 text-[9px] text-neutral-500 cursor-pointer">
                <input type="checkbox" checked={ss.sequentialBatch} onChange={() => ss.setSequentialBatch(!ss.sequentialBatch)}
                  className="rounded border-surface-border w-3 h-3" /> Sequential
              </label>
            </div>
          </div>

          <div className="border-t border-surface-border" />

          {/* VLM Animate */}
          <div className={`flex items-center justify-between ${!vlmEnabled ? 'opacity-40' : ''}`}>
            <div>
              <span className="text-[10px] text-neutral-400">VLM Auto-Animate</span>
              <p className="text-[8px] text-neutral-600">{vlmEnabled ? 'Skip prompt preview — generate video immediately' : 'No VLM preset selected'}</p>
            </div>
            <button onClick={() => vlmEnabled && ss.setVlmAutoAnimate?.(!ss.vlmAutoAnimate)} disabled={!vlmEnabled}
              className={`w-9 h-5 rounded-full relative transition-colors shrink-0 ${!vlmEnabled ? 'bg-neutral-800 border border-neutral-700 cursor-not-allowed' : ss.vlmAutoAnimate ? 'bg-emerald-500' : 'bg-neutral-800 border border-neutral-700'}`}>
              <div className={`w-3.5 h-3.5 bg-white rounded-full absolute top-[3px] transition-all shadow-sm ${ss.vlmAutoAnimate && vlmEnabled ? 'left-[18px]' : 'left-[3px]'}`} />
            </button>
          </div>

          <div className="border-t border-surface-border" />

          {/* LoRAs */}
          <div>
            <span className="text-[10px] text-neutral-500 mb-1 block">LoRAs</span>
            <div className="mb-1.5 max-w-full overflow-hidden">
              <ModelPicker models={ss.comfyLoras} value="" onChange={(v) => { if (v) ss.addLora({ name: v }); }}
                placeholder="+ Add LoRA..." compact />
            </div>
            {ss.studioLoras.length > 0 && (
              <div className="space-y-1 max-h-[120px] overflow-y-auto">
                {ss.studioLoras.map(lora => (
                  <div key={lora.id} className={`bg-bg-700 rounded-md px-2 py-1.5 group ${lora.enabled === false ? 'opacity-40' : ''}`}>
                    <div className="flex items-center gap-1 mb-0.5">
                      <button onClick={() => ss.updateLora(lora.id, { enabled: !(lora.enabled !== false) })}
                        className={`w-5 h-3 rounded-full relative transition-colors shrink-0 ${lora.enabled !== false ? 'bg-accent' : 'bg-neutral-700'}`}>
                        <div className={`w-2 h-2 bg-white rounded-full absolute top-0.5 transition-all ${lora.enabled !== false ? 'left-2.5' : 'left-0.5'}`} />
                      </button>
                      <span className="text-[9px] text-neutral-300 truncate flex-1">{lora.name?.split(/[/\\]/).pop()}</span>
                      <button onClick={() => ss.removeLora(lora.id)} className="opacity-0 group-hover:opacity-100 text-neutral-600 hover:text-red-400"><X size={10} /></button>
                    </div>
                    {lora.enabled !== false && (
                      <div className="flex items-center gap-1">
                        <input type="range" min="0" max="2" step="0.05" value={lora.strength ?? 1}
                          onChange={(e) => ss.updateLora(lora.id, { strength: parseFloat(e.target.value) })} className="flex-1" />
                        <span className="text-[9px] text-neutral-500 w-7 text-right tabular-nums">{(lora.strength ?? 1).toFixed(2)}</span>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
