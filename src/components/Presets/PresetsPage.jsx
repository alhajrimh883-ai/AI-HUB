import React, { useState, useEffect } from 'react';
import usePresetStore from '../../lib/presetStore';
import useStore from '../../lib/store';
import useDirectorStore from '../../lib/directorStore';
import { TYPES, MODES, FAMILIES, getFamiliesByType, getFamily, validateRequired } from '../../lib/presetRegistry';
import ModelPicker from '../ModelPicker';
import { Plus, Trash2, Edit3, Save, X, AlertTriangle, Check, ChevronDown } from 'lucide-react';

// ── Map scanFolder → store array ──
function useModelsForFolder(scanFolder) {
  const store = useStore();
  if (!scanFolder) return [];
  if (scanFolder === 'checkpoints') return store.comfyCheckpoints || [];
  if (scanFolder === 'loras') return store.comfyLoras || [];
  if (scanFolder === 'vae') return store.comfyVaes || [];
  if (scanFolder === 'text_encoders') return store.comfyClips || [];
  if (scanFolder === 'upscale_models') return store.comfyUpscaleModels || [];
  if (scanFolder === 'diffusion_models') return store.comfyUnets || [];
  return [];
}

// ── Model Field — uses ModelPicker or file browser ──
function ModelField({ value, onChange, scanFolder, placeholder }) {
  if (scanFolder === 'file_browser') {
    return (
      <div className="flex gap-1">
        <input type="text" value={value || ''} onChange={e => onChange(e.target.value)}
          placeholder={placeholder || 'Path to file...'}
          className="input-field text-[10px] flex-1 truncate" />
        <button onClick={async () => {
          if (!window.electronAPI) return;
          const p = await window.electronAPI.selectFile([{ name: 'GGUF Models', extensions: ['gguf'] }]);
          if (p) onChange(p);
        }} className="btn btn-ghost text-[9px] px-2 py-1 border border-surface-border shrink-0">Browse</button>
      </div>
    );
  }
  const models = useModelsForFolder(scanFolder);
  return <ModelPicker models={models} value={value || ''} onChange={onChange}
    placeholder={placeholder || 'Select model...'} compact />;
}

// ── Preset Editor Form ──
function PresetEditor({ preset, onSave, onCancel, separate }) {
  const ps = usePresetStore();
  const [name, setName] = useState(preset?.name || '');
  const [description, setDescription] = useState(preset?.description || '');
  const [type, setType] = useState(preset?.type || 't2i');
  const [family, setFamily] = useState(preset?.family || '');
  const [workflow, setWorkflow] = useState(preset?.workflow || '');
  const [mode, setMode] = useState(preset?.mode || 'fast');
  const [models, setModels] = useState(preset?.models || {});
  const [loras, setLoras] = useState(preset?.loras || []);
  const [settings, setSettings] = useState(preset?.settings || {});
  const [negPrompt, setNegPrompt] = useState(preset?.negPrompt || '');
  const [backupPreset, setBackupPreset] = useState(preset?.backupPreset || '');
  const [linkedLoraIds, setLinkedLoraIds] = useState(preset?.linkedLoraIds || []);
  // Combined mode: separate settings + loras per mode
  const [fastSettings, setFastSettings] = useState(preset?.fast?.settings || preset?.settings || {});
  const [fastLoras, setFastLoras] = useState(preset?.fast?.loras || preset?.loras || []);
  const [qualitySettings, setQualitySettings] = useState(preset?.quality?.settings || preset?.settings || {});
  const [qualityLoras, setQualityLoras] = useState(preset?.quality?.loras || preset?.loras || []);
  const isCombined = mode === 'combined';
  const isEdit = !!preset?.id;

  // Derive modelType from family (user can override for SDXL → Pony/Illustrious)
  const familyToModelType = (f) => {
    if (!f) return '';
    if (f.includes('wan22')) return 'wan22';
    if (f.includes('edit') || f.includes('qwen')) return 'qwen_edit';
    if (f.includes('sdxl') || f.includes('illust') || f.includes('pony')) return 'sdxl';
    return 'sdxl';
  };
  const [modelType, setModelType] = useState(preset?.modelType || familyToModelType(preset?.family || ''));

  const familyDef = getFamily(family);
  const families = getFamiliesByType(type, type === 'video' ? separate : false);

  // Resolve workflow-specific fields and settings
  const wfDef = familyDef?.workflows?.[workflow] || null;
  const activeFields = wfDef?.fields || familyDef?.fields || [];
  // For workflow families: use workflow's settings list
  // For non-workflow families: derive from defaults (hide shift if null)
  const activeSettings = wfDef?.settings
    || (familyDef ? ['steps', 'cfg', ...(familyDef.defaults?.fast?.shift !== null && familyDef.defaults?.fast?.shift !== undefined ? ['shift'] : [])] : []);

  // When family changes, reset models and apply default settings
  useEffect(() => {
    if (!familyDef) return;
    if (!isEdit) {
      setModels({});
      setModelType(familyToModelType(family));
      const defMode = mode === 'both' ? 'fast' : mode;
      setSettings(familyDef.defaults?.[defMode] || {});
      // Auto-select first workflow if family has workflows
      if (familyDef.workflows) {
        const keys = Object.keys(familyDef.workflows);
        if (keys.length > 0 && !workflow) setWorkflow(keys[0]);
      } else {
        setWorkflow('');
      }
    }
  }, [family]);

  useEffect(() => {
    if (familyDef?.defaults) {
      const defMode = mode === 'both' ? 'fast' : mode;
      if (familyDef.defaults[defMode]) {
        setSettings(s => ({ ...familyDef.defaults[defMode], ...s }));
      }
    }
  }, [mode, familyDef]);

  const handleSave = () => {
    if (!name.trim() || !family) return;
    const base = { name: name.trim(), description: description.trim(), type, family, workflow, mode, models, negPrompt, backupPreset, linkedLoraIds, modelType };
    if (isCombined) {
      onSave({ ...base, fast: { settings: fastSettings, loras: fastLoras }, quality: { settings: qualitySettings, loras: qualityLoras } });
    } else {
      onSave({ ...base, loras, settings });
    }
  };

  return (
    <div className="bg-bg-800 rounded-xl border border-surface-border p-4 space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold">{isEdit ? 'Edit Preset' : 'New Preset'}</span>
        <button onClick={onCancel} className="text-neutral-500 hover:text-white"><X size={14} /></button>
      </div>

      {/* Name */}
      <input value={name} onChange={e => setName(e.target.value)} placeholder="Preset name..."
        className="input-field text-[11px] w-full" />

      {/* Description */}
      <div>
        <textarea value={description} onChange={e => setDescription(e.target.value)}
          placeholder="Describe what this preset is best for — the VLM reads this to auto-select the right preset for a prompt..."
          rows={2} className="input-field text-[10px] w-full resize-none" />
      </div>

      {/* Type + Family + Mode */}
      <div className={`grid gap-2 ${type === 'vlm' ? 'grid-cols-1' : 'grid-cols-3'}`}>
        <div>
          <label className="text-[8px] text-neutral-500 block mb-0.5">Type</label>
          <select value={type} onChange={e => {
            const t = e.target.value;
            setType(t);
            // Auto-select family for single-family types
            const fams = getFamiliesByType(t, false);
            if (fams.length === 1) { setFamily(fams[0][0]); } else { setFamily(''); }
            // VLM always uses 'both' mode
            if (t === 'vlm') setMode('both');
          }}
            disabled={isEdit}
            className="input-field text-[10px] w-full">
            {Object.entries(TYPES).map(([k, v]) => <option key={k} value={k}>{v.icon} {v.label}</option>)}
          </select>
        </div>
        {type !== 'vlm' && (
          <>
            <div>
              <label className="text-[8px] text-neutral-500 block mb-0.5">Family</label>
              <select value={family} onChange={e => setFamily(e.target.value)}
                disabled={isEdit}
                className="input-field text-[10px] w-full">
                <option value="">Select...</option>
                {families.map(([k, f]) => <option key={k} value={k}>{f.label}</option>)}
              </select>
            </div>
            <div>
              <label className="text-[8px] text-neutral-500 block mb-0.5">Mode</label>
              {isCombined ? (
                <div className="text-[9px] bg-bg-700 rounded px-2 py-1.5 text-blue-300">⚡🎨 Combined</div>
              ) : (
                <select value={mode} onChange={e => setMode(e.target.value)}
                  className="input-field text-[10px] w-full">
                  {Object.entries(MODES).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
                </select>
              )}
            </div>
          </>
        )}
      </div>

      {/* Model Type — for LoRA linking */}
      {type !== 'vlm' && family && (
        <div>
          <label className="text-[8px] text-neutral-500 block mb-0.5">Model Type <span className="text-neutral-600">(for LoRA linking)</span></label>
          {family.includes('sdxl') ? (
            <div className="flex gap-1">
              {[{ val: 'sdxl', label: 'SDXL' }, { val: 'pony', label: 'Pony' }, { val: 'illustrious', label: 'Illustrious' }].map(o => (
                <button key={o.val} onClick={() => setModelType(o.val)}
                  className={`flex-1 text-[9px] py-1 rounded font-medium transition-colors ${modelType === o.val ? 'bg-accent/20 text-accent border border-accent/30' : 'bg-bg-700 text-neutral-500 border border-transparent'}`}>
                  {o.label}
                </button>
              ))}
            </div>
          ) : (
            <div className="text-[9px] text-neutral-400 bg-bg-700 rounded px-2 py-1">
              {modelType === 'wan22' ? 'Wan 2.2' : modelType === 'qwen_edit' ? 'Qwen Edit' : modelType || 'Auto'}
            </div>
          )}
        </div>
      )}

      {/* Workflow selector (for families with multiple workflows) */}
      {familyDef?.workflows && (
        <div>
          <label className="text-[8px] text-neutral-500 block mb-0.5">Workflow</label>
          <select value={workflow} onChange={e => setWorkflow(e.target.value)}
            className="input-field text-[10px] w-full">
            <option value="">Select workflow...</option>
            {Object.entries(familyDef.workflows).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>
        </div>
      )}

      {/* Workflow description */}
      {wfDef?.description && (
        <p className="text-[9px] text-amber-400/70 bg-amber-500/5 border border-amber-500/10 rounded-lg px-3 py-2">{wfDef.description}</p>
      )}

      {/* Backup T2I Preset (for SDXL HireFix) */}
      {wfDef?.hasBackupPreset && (
        <div>
          <label className="text-[9px] text-neutral-400 block mb-0.5">Backup T2I Preset</label>
          <p className="text-[8px] text-neutral-600 mb-1">Used when image metadata is missing (checkpoint + CFG)</p>
          <select value={backupPreset} onChange={e => setBackupPreset(e.target.value)}
            className="input-field text-[10px] w-full truncate">
            <option value="">None (metadata required)</option>
            {ps.presets.filter(p => p.type === 't2i').map(p => (
              <option key={p.id} value={p.id}>{p.name} — {p.models?.checkpoint?.split(/[/\\]/).pop() || 'no model'}</option>
            ))}
          </select>
        </div>
      )}

      {/* Model Fields (workflow-aware) */}
      {familyDef && activeFields.length > 0 && (
        <div className="space-y-2">
          <label className="text-[9px] text-neutral-400 block">Models</label>
          {activeFields.map(field => (
            <div key={field}>
              <label className="text-[8px] text-neutral-500 block mb-0.5">{familyDef.fieldLabels[field]}</label>
              <ModelField value={models[field]} scanFolder={familyDef.fieldScanFolder[field]}
                onChange={v => setModels(m => ({ ...m, [field]: v }))} />
            </div>
          ))}
        </div>
      )}

      {/* Negative Prompt (T2I + Edit) */}
      {familyDef && (type === 't2i' || type === 'edit') && (
        <div>
          <label className="text-[9px] text-neutral-400 block mb-0.5">Negative Prompt</label>
          <textarea value={negPrompt} onChange={e => setNegPrompt(e.target.value)}
            placeholder="Things to avoid in generation..."
            rows={2} className="input-field text-[10px] resize-y w-full" />
        </div>
      )}

      {/* Generation Settings (workflow-aware, hidden for VLM) */}
      {familyDef && type !== 'vlm' && !isCombined && (
        <div className="grid grid-cols-3 gap-2">
          {activeSettings.includes('steps') && (
            <div>
              <label className="text-[8px] text-neutral-500 block mb-0.5">Steps</label>
              <input type="number" value={settings.steps || ''} onChange={e => setSettings(s => ({ ...s, steps: parseInt(e.target.value) || 4 }))}
                className="input-field text-[10px] w-full" />
            </div>
          )}
          {activeSettings.includes('cfg') && (
            <div>
              <label className="text-[8px] text-neutral-500 block mb-0.5">CFG</label>
              <input type="number" step="0.5" value={settings.cfg ?? ''} onChange={e => setSettings(s => ({ ...s, cfg: parseFloat(e.target.value) || 1 }))}
                className="input-field text-[10px] w-full" />
            </div>
          )}
          {activeSettings.includes('shift') && (
            <div>
              <label className="text-[8px] text-neutral-500 block mb-0.5">Shift</label>
              <input type="number" value={settings.shift ?? ''} onChange={e => setSettings(s => ({ ...s, shift: parseFloat(e.target.value) || 3 }))}
                className="input-field text-[10px] w-full" />
            </div>
          )}
        </div>
      )}

      {/* Combined Mode: dual settings columns */}
      {familyDef && type !== 'vlm' && isCombined && (
        <div className="grid grid-cols-2 gap-3">
          {/* Fast settings */}
          <div className="bg-amber-500/5 border border-amber-500/20 rounded-lg p-2.5 space-y-2">
            <span className="text-[8px] font-bold text-amber-400">⚡ Fast Settings</span>
            {activeSettings.includes('steps') && (
              <div>
                <label className="text-[8px] text-neutral-500 block mb-0.5">Steps</label>
                <input type="number" value={fastSettings.steps || ''} onChange={e => setFastSettings(s => ({ ...s, steps: parseInt(e.target.value) || 4 }))}
                  className="input-field text-[10px] w-full" />
              </div>
            )}
            {activeSettings.includes('cfg') && (
              <div>
                <label className="text-[8px] text-neutral-500 block mb-0.5">CFG</label>
                <input type="number" step="0.5" value={fastSettings.cfg ?? ''} onChange={e => setFastSettings(s => ({ ...s, cfg: parseFloat(e.target.value) || 1 }))}
                  className="input-field text-[10px] w-full" />
              </div>
            )}
            {activeSettings.includes('shift') && (
              <div>
                <label className="text-[8px] text-neutral-500 block mb-0.5">Shift</label>
                <input type="number" value={fastSettings.shift ?? ''} onChange={e => setFastSettings(s => ({ ...s, shift: parseFloat(e.target.value) || 3 }))}
                  className="input-field text-[10px] w-full" />
              </div>
            )}
          </div>
          {/* Quality settings */}
          <div className="bg-violet-500/5 border border-violet-500/20 rounded-lg p-2.5 space-y-2">
            <span className="text-[8px] font-bold text-violet-400">🎨 Quality Settings</span>
            {activeSettings.includes('steps') && (
              <div>
                <label className="text-[8px] text-neutral-500 block mb-0.5">Steps</label>
                <input type="number" value={qualitySettings.steps || ''} onChange={e => setQualitySettings(s => ({ ...s, steps: parseInt(e.target.value) || 20 }))}
                  className="input-field text-[10px] w-full" />
              </div>
            )}
            {activeSettings.includes('cfg') && (
              <div>
                <label className="text-[8px] text-neutral-500 block mb-0.5">CFG</label>
                <input type="number" step="0.5" value={qualitySettings.cfg ?? ''} onChange={e => setQualitySettings(s => ({ ...s, cfg: parseFloat(e.target.value) || 7 }))}
                  className="input-field text-[10px] w-full" />
              </div>
            )}
            {activeSettings.includes('shift') && (
              <div>
                <label className="text-[8px] text-neutral-500 block mb-0.5">Shift</label>
                <input type="number" value={qualitySettings.shift ?? ''} onChange={e => setQualitySettings(s => ({ ...s, shift: parseFloat(e.target.value) || 3 }))}
                  className="input-field text-[10px] w-full" />
              </div>
            )}
          </div>
        </div>
      )}

      {/* HireFix Shared Settings */}
      {familyDef && type === 'hirefix' && (
        <div className="grid grid-cols-3 gap-2">
          <div>
            <label className="text-[8px] text-neutral-500 block mb-0.5">Denoise</label>
            <input type="number" step="0.05" min="0" max="1" value={settings.denoise ?? 0.5}
              onChange={e => setSettings(s => ({ ...s, denoise: parseFloat(e.target.value) || 0.5 }))}
              className="input-field text-[10px] w-full" />
          </div>
          <div>
            <label className="text-[8px] text-neutral-500 block mb-0.5">Upscale By</label>
            <input type="number" step="0.25" min="1" max="4" value={settings.upscaleBy ?? 1.5}
              onChange={e => setSettings(s => ({ ...s, upscaleBy: parseFloat(e.target.value) || 1.5 }))}
              className="input-field text-[10px] w-full" />
          </div>
          <div>
            <label className="text-[8px] text-neutral-500 block mb-0.5">Upscale Model</label>
            <ModelField value={settings.upscaleModel || ''} scanFolder="upscale_models"
              onChange={v => setSettings(s => ({ ...s, upscaleModel: v }))} />
          </div>
        </div>
      )}

      {/* VLM Settings */}
      {familyDef?.hasVlmSettings && (
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="text-[8px] text-neutral-500 block mb-0.5">Context Length</label>
            <select value={settings.ctx || 8192} onChange={e => setSettings(s => ({ ...s, ctx: parseInt(e.target.value) }))}
              className="input-field text-[10px] w-full">
              {[1024, 2048, 4096, 8192, 16384, 32768, 65536].map(v => (
                <option key={v} value={v}>{v / 1024}K</option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-[8px] text-neutral-500 block mb-0.5">Image Tokens</label>
            <select value={settings.imageTokens || 1024} onChange={e => setSettings(s => ({ ...s, imageTokens: parseInt(e.target.value) }))}
              className="input-field text-[10px] w-full">
              {[128, 256, 512, 1024, 2048, 4096].map(v => (
                <option key={v} value={v}>{v}</option>
              ))}
            </select>
            <p className="text-[8px] text-neutral-600 mt-0.5">Higher = more detail, uses more context</p>
          </div>
        </div>
      )}

      {/* Always-On LoRAs (hidden for VLM) */}
      {familyDef && type !== 'vlm' && (
        <div>
          <div className="flex items-center justify-between mb-1">
            <label className="text-[9px] text-neutral-400">Always-On LoRAs {familyDef.dualLora && <span className="text-neutral-600">(High + Low)</span>}</label>
            <button onClick={() => setLoras(l => [...l, familyDef.dualLora
              ? { nameHigh: '', nameLow: '', strengthHigh: 1.0, strengthLow: 1.0 }
              : { name: '', strength: 1.0 }
            ])}
              className="text-[8px] text-accent hover:text-white flex items-center gap-0.5">
              <Plus size={8} /> Add
            </button>
          </div>
          {loras.map((lora, idx) => (
            <div key={idx} className="mb-2 bg-bg-700/50 rounded-lg border border-surface-border/30 p-2 relative">
              <button onClick={() => setLoras(l => l.filter((_, i) => i !== idx))}
                className="absolute top-1.5 right-1.5 text-red-400/60 hover:text-red-300"><X size={10} /></button>
              {familyDef.dualLora ? (
                <div className="space-y-1 pr-5">
                  <div className="flex items-center gap-1.5">
                    <span className="text-[7px] font-bold text-amber-400/70 w-7 shrink-0">HIGH</span>
                    <div className="flex-1 min-w-0">
                      <ModelField value={lora.nameHigh} scanFolder="loras"
                        onChange={v => setLoras(l => l.map((x, i) => i === idx ? { ...x, nameHigh: v } : x))}
                        placeholder="LoRA HIGH..." />
                    </div>
                    <input type="number" step="0.1" min="0" max="2" value={lora.strengthHigh ?? 1}
                      onChange={e => setLoras(l => l.map((x, i) => i === idx ? { ...x, strengthHigh: parseFloat(e.target.value) || 1 } : x))}
                      className="input-field text-[10px] w-[4.5rem] max-w-[4.5rem] shrink-0 text-center py-1" />
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="text-[7px] font-bold text-blue-400/70 w-7 shrink-0">LOW</span>
                    <div className="flex-1 min-w-0">
                      <ModelField value={lora.nameLow} scanFolder="loras"
                        onChange={v => setLoras(l => l.map((x, i) => i === idx ? { ...x, nameLow: v } : x))}
                        placeholder="LoRA LOW..." />
                    </div>
                    <input type="number" step="0.1" min="0" max="2" value={lora.strengthLow ?? 1}
                      onChange={e => setLoras(l => l.map((x, i) => i === idx ? { ...x, strengthLow: parseFloat(e.target.value) || 1 } : x))}
                      className="input-field text-[10px] w-[4.5rem] max-w-[4.5rem] shrink-0 text-center py-1" />
                  </div>
                </div>
              ) : (
                <div className="flex gap-1.5 items-center pr-5">
                  <div className="flex-1 min-w-0">
                    <ModelField value={lora.name} scanFolder="loras"
                      onChange={v => setLoras(l => l.map((x, i) => i === idx ? { ...x, name: v } : x))}
                      placeholder="Select LoRA..." />
                  </div>
                  <input type="number" step="0.1" min="0" max="2" value={lora.strength}
                    onChange={e => setLoras(l => l.map((x, i) => i === idx ? { ...x, strength: parseFloat(e.target.value) || 1 } : x))}
                    className="input-field text-[10px] w-[4.5rem] max-w-[4.5rem] shrink-0 text-center py-1" />
                </div>
              )}
            </div>
          ))}
          {loras.length === 0 && <p className="text-[8px] text-neutral-600">None — only user-selected LoRAs will apply</p>}
        </div>
      )}

      {/* Linked LoRAs from Pool (not for VLM or video — video uses Director LoRAs) */}
      {type !== 'vlm' && type !== 'video' && (
        <div>
          <label className="text-[9px] text-neutral-400 block mb-1">Linked LoRAs from Pool</label>
          {linkedLoraIds.length > 0 && (
            <div className="space-y-1 mb-2">
              {linkedLoraIds.map(lid => {
                const lora = ps.loraPresets.find(l => l.id === lid);
                if (!lora) return null;
                return (
                  <div key={lid} className="flex items-center gap-2 bg-bg-700/50 rounded-lg border border-surface-border/30 px-2 py-1.5">
                    <div className="flex-1 min-w-0">
                      <span className="text-[9px] font-semibold text-neutral-300">{lora.name}</span>
                      <span className={`text-[7px] ml-1 px-1 rounded ${lora.isDual ? 'bg-amber-500/20 text-amber-400' : 'bg-accent/20 text-accent'}`}>
                        {lora.isDual ? 'Dual' : 'Single'}
                      </span>
                      {lora.description && <p className="text-[8px] text-neutral-500 truncate">{lora.description}</p>}
                    </div>
                    <button onClick={() => setLinkedLoraIds(ids => ids.filter(id => id !== lid))}
                      className="text-red-400/60 hover:text-red-300 shrink-0"><X size={10} /></button>
                  </div>
                );
              })}
            </div>
          )}
          {ps.loraPresets.filter(l => !linkedLoraIds.includes(l.id)).length > 0 ? (
            <select value="" onChange={e => { if (e.target.value) setLinkedLoraIds(ids => [...ids, e.target.value]); }}
              className="select-field text-[9px] w-full">
              <option value="">+ Link a LoRA from pool...</option>
              {ps.loraPresets.filter(l => !linkedLoraIds.includes(l.id)).map(l => (
                <option key={l.id} value={l.id}>{l.name} — {l.description?.substring(0, 40) || 'no desc'}</option>
              ))}
            </select>
          ) : ps.loraPresets.length === 0 ? (
            <p className="text-[8px] text-neutral-600">No LoRA presets in pool. Create some in the LoRA Pool section.</p>
          ) : (
            <p className="text-[8px] text-neutral-600">All pool LoRAs are linked.</p>
          )}
        </div>
      )}

      {/* Save */}
      <div className="flex justify-end gap-2 pt-2 border-t border-surface-border">
        <button onClick={onCancel} className="btn btn-ghost text-[10px] px-3 py-1">Cancel</button>
        <button onClick={handleSave} disabled={!name.trim() || !family}
          className="btn bg-accent text-white text-[10px] px-4 py-1 disabled:opacity-30 flex items-center gap-1">
          <Save size={10} /> {isEdit ? 'Update' : 'Create'}
        </button>
      </div>
    </div>
  );
}

// ── Preset Card ──
function PresetCard({ preset, onEdit, onDelete, onSplit }) {
  const familyDef = getFamily(preset.family);
  const modeInfo = MODES[preset.mode];
  const isCombined = preset.mode === 'combined';
  return (
    <div className={`bg-bg-700 rounded-lg border p-3 ${isCombined ? 'border-blue-500/30' : 'border-surface-border'}`}>
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-semibold text-white">{preset.name}</span>
          {isCombined ? (
            <span className="text-[7px] font-bold px-1.5 py-0.5 rounded-full bg-gradient-to-r from-amber-500/20 to-violet-500/20 text-blue-300">⚡🎨 Combined</span>
          ) : (
            <span className={`text-[7px] font-bold px-1.5 py-0.5 rounded-full ${
              preset.mode === 'fast' ? 'bg-amber-500/20 text-amber-400' : preset.mode === 'quality' ? 'bg-violet-500/20 text-violet-400' : 'bg-blue-500/20 text-blue-400'
            }`}>{modeInfo?.label}</span>
          )}
        </div>
        <div className="flex gap-1">
          {isCombined && onSplit && (
            <button onClick={() => onSplit(preset.id)} className="text-[9px] px-1.5 py-0.5 rounded bg-blue-500/10 border border-blue-500/30 text-blue-400 hover:bg-blue-500/20">Split</button>
          )}
          <button onClick={() => onEdit(preset)} className="text-neutral-500 hover:text-accent"><Edit3 size={11} /></button>
          <button onClick={() => onDelete(preset.id)} className="text-neutral-500 hover:text-red-400"><Trash2 size={11} /></button>
        </div>
      </div>
      <div className="text-[8px] text-neutral-500 mb-1">
        {familyDef?.label || preset.family}
        {preset.workflow && familyDef?.workflows?.[preset.workflow] && (
          <span className="text-neutral-600 ml-1">· {familyDef.workflows[preset.workflow].label}</span>
        )}
        {preset.linkedLoraIds?.length > 0 && (
          <span className="text-violet-400 ml-1">· {preset.linkedLoraIds.length} LoRA{preset.linkedLoraIds.length > 1 ? 's' : ''}</span>
        )}
        {preset.modelType && (
          <span className="text-neutral-600 ml-1">· {preset.modelType === 'wan22' ? 'Wan 2.2' : preset.modelType === 'qwen_edit' ? 'Qwen Edit' : preset.modelType === 'pony' ? 'Pony' : preset.modelType === 'illustrious' ? 'Illustrious' : 'SDXL'}</span>
        )}
      </div>
      {preset.description && (
        <p className="text-[8px] text-neutral-400 mb-1.5 line-clamp-2 italic">{preset.description}</p>
      )}
      <div className="space-y-0.5">
        {(familyDef?.workflows?.[preset.workflow]?.fields || familyDef?.fields || []).map(field => (
          <div key={field} className="flex gap-1 text-[8px]">
            <span className="text-neutral-600 w-20 shrink-0">{familyDef?.fieldLabels?.[field] || field}:</span>
            <span className="text-neutral-400 truncate">{preset.models?.[field]?.split(/[/\\]/).pop() || '—'}</span>
          </div>
        ))}
        {preset.loras?.length > 0 && (
          <div className="flex gap-1 text-[8px] mt-1">
            <span className="text-neutral-600 w-20 shrink-0">LoRAs:</span>
            <span className="text-amber-400">{preset.loras.length} always-on</span>
          </div>
        )}
        <div className="flex gap-2 text-[8px] text-neutral-600 mt-1">
          <span>Steps: {preset.settings?.steps}</span>
          <span>CFG: {preset.settings?.cfg}</span>
          {preset.settings?.shift != null && <span>Shift: {preset.settings?.shift}</span>}
        </div>
      </div>
    </div>
  );
}

// ── Main Presets Page ──
export default function PresetsPage() {
  const ps = usePresetStore();
  const ds = useDirectorStore();
  const vs = useStore();
  const [editing, setEditing] = useState(null); // null | 'new' | preset object
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [showLoraOverlay, setShowLoraOverlay] = useState(false);
  const [showLoraPool, setShowLoraPool] = useState(false);
  const [editingPoolLora, setEditingPoolLora] = useState(null);
  const [editingLora, setEditingLora] = useState(null);
  const [showCombine, setShowCombine] = useState(false);
  const [combineFastId, setCombineFastId] = useState('');
  const [combineQualityId, setCombineQualityId] = useState('');
  const [activeSection, setActiveSection] = useState('t2i');

  const handleSave = (data) => {
    if (editing?.id) {
      ps.updatePreset(editing.id, data);
    } else {
      ps.addPreset(data);
    }
    setEditing(null);
  };

  const handleDelete = (id) => {
    ps.deletePreset(id);
    setConfirmDelete(null);
  };

  // Group presets by type
  const t2iPresets = ps.presets.filter(p => p.type === 't2i');
  const videoPresets = ps.presets.filter(p => p.type === 'video');
  const editPresets = ps.presets.filter(p => p.type === 'edit');
  const hirefixPresets = ps.presets.filter(p => p.type === 'hirefix');
  const vlmPresets = ps.presets.filter(p => p.type === 'vlm');

  // Find families with required models
  const familiesWithRequired = Object.entries(FAMILIES).filter(([, f]) => {
    if (!f.required.length) return false;
    if (f.type === 'video') {
      if (ps.separateVideoPresets && f.unifiedOnly) return false;
      if (!ps.separateVideoPresets && f.separateOnly) return false;
    }
    return true;
  });


  const sectionCounts = {
    t2i: t2iPresets.length, video: videoPresets.length, edit: editPresets.length,
    hirefix: hirefixPresets.length, vlm: vlmPresets.length,
    loraPool: ps.loraPresets.length, directorLora: ds.loraPresets.length,
  };

  const activePresets = activeSection === 't2i' ? t2iPresets
    : activeSection === 'video' ? videoPresets
    : activeSection === 'edit' ? editPresets
    : activeSection === 'hirefix' ? hirefixPresets
    : activeSection === 'vlm' ? vlmPresets
    : [];

  return (
    <div className="h-full flex overflow-hidden">

      {/* ── Sidebar ── */}
      <div className="w-48 shrink-0 border-r border-surface-border bg-bg-800/30 flex flex-col overflow-y-auto">
        <div className="p-3 space-y-4">
          {/* Generation */}
          <div>
            <span className="text-[7px] text-neutral-600 uppercase tracking-widest font-bold block mb-1.5">Generation</span>
            {[
              { key: 't2i', icon: '🖼️', label: 'Image' },
              { key: 'video', icon: '🎬', label: 'Video' },
              { key: 'edit', icon: '✏️', label: 'Edit' },
              { key: 'hirefix', icon: '🔍', label: 'HireFix' },
              { key: 'vlm', icon: '🧠', label: 'VLM' },
            ].map(s => (
              <button key={s.key} onClick={() => setActiveSection(s.key)}
                className={`w-full flex items-center gap-2 px-2 py-1.5 rounded text-[10px] transition-colors ${
                  activeSection === s.key ? 'bg-accent/10 text-accent' : 'text-neutral-500 hover:text-neutral-300 hover:bg-bg-700'
                }`}>
                <span className="text-[11px]">{s.icon}</span>
                <span className="flex-1 text-left">{s.label}</span>
                <span className="text-[8px] text-neutral-600 font-mono">{sectionCounts[s.key]}</span>
              </button>
            ))}
          </div>
          {/* LoRAs */}
          <div>
            <span className="text-[7px] text-neutral-600 uppercase tracking-widest font-bold block mb-1.5">LoRAs</span>
            <button onClick={() => setActiveSection('loraPool')}
              className={`w-full flex items-center gap-2 px-2 py-1.5 rounded text-[10px] transition-colors ${
                activeSection === 'loraPool' ? 'bg-accent/10 text-accent' : 'text-neutral-500 hover:text-neutral-300 hover:bg-bg-700'
              }`}>
              <span className="text-[11px]">🔗</span>
              <span className="flex-1 text-left">LoRA Pool</span>
              <span className="text-[8px] text-neutral-600 font-mono">{sectionCounts.loraPool}</span>
            </button>
            <button onClick={() => setActiveSection('directorLora')}
              className={`w-full flex items-center gap-2 px-2 py-1.5 rounded text-[10px] transition-colors ${
                activeSection === 'directorLora' ? 'bg-accent/10 text-accent' : 'text-neutral-500 hover:text-neutral-300 hover:bg-bg-700'
              }`}>
              <span className="text-[11px]">🎬</span>
              <span className="flex-1 text-left">Director</span>
              <span className="text-[8px] text-neutral-600 font-mono">{sectionCounts.directorLora}</span>
            </button>
          </div>
          {/* Settings */}
          <div>
            <span className="text-[7px] text-neutral-600 uppercase tracking-widest font-bold block mb-1.5">Settings</span>
            <button onClick={() => setActiveSection('settings')}
              className={`w-full flex items-center gap-2 px-2 py-1.5 rounded text-[10px] transition-colors ${
                activeSection === 'settings' ? 'bg-accent/10 text-accent' : 'text-neutral-500 hover:text-neutral-300 hover:bg-bg-700'
              }`}>
              <span className="text-[11px]">⚙️</span>
              <span className="flex-1 text-left">Options</span>
            </button>
          </div>
        </div>
      </div>

      {/* ── Content ── */}
      <div className="flex-1 overflow-y-auto p-4 space-y-3">

        {/* Editor (shown over content when editing) */}
        {editing && (
          <PresetEditor
            preset={editing === 'new' ? null : editing}
            separate={ps.separateVideoPresets}
            onSave={handleSave}
            onCancel={() => setEditing(null)} />
        )}

        {!editing && (
          <>
            {/* ── Generation Preset Sections ── */}
            {['t2i', 'video', 'edit', 'hirefix', 'vlm'].includes(activeSection) && (
              <>
                {/* Header */}
                <div className="flex items-center justify-between">
                  <h2 className="text-sm font-semibold text-neutral-200">
                    {activeSection === 't2i' ? '🖼️ Image' : activeSection === 'video' ? '🎬 Video' : activeSection === 'edit' ? '✏️ Edit' : activeSection === 'hirefix' ? '🔍 HireFix' : '🧠 VLM'} Presets
                    <span className="text-[9px] text-neutral-600 ml-2">{activePresets.length}</span>
                  </h2>
                  <div className="flex gap-2">
                    <button onClick={() => setEditing('new')}
                      className="btn bg-accent text-white text-[10px] px-3 py-1.5 flex items-center gap-1">
                      <Plus size={10} /> New
                    </button>
                    {activeSection !== 'vlm' && (
                      <button onClick={() => { setShowCombine(true); setCombineFastId(''); setCombineQualityId(''); }}
                        className="btn btn-ghost text-[10px] px-3 py-1.5 border border-blue-500/30 text-blue-400 hover:bg-blue-500/10">
                        ⚡🎨 Combine
                      </button>
                    )}
                  </div>
                </div>

                {/* Preset Grid */}
                {activePresets.length === 0 ? (
                  <div className="bg-bg-800 rounded-xl border border-dashed border-surface-border p-8 text-center">
                    <p className="text-[11px] text-neutral-500 mb-1">No presets yet</p>
                    <button onClick={() => setEditing('new')} className="text-[10px] text-accent hover:underline">Create one →</button>
                  </div>
                ) : (
                  <div className="grid grid-cols-2 gap-3">
                    {activePresets.map(p => (
                      <PresetCard key={p.id} preset={p}
                        onEdit={(pr) => setEditing(pr)}
                        onDelete={(id) => setConfirmDelete(id)} onSplit={(id) => ps.splitPreset(id)} />
                    ))}
                  </div>
                )}
              </>
            )}

            {/* ── LoRA Pool Section ── */}
            {activeSection === 'loraPool' && (
              <>
                <div className="flex items-center justify-between">
                  <h2 className="text-sm font-semibold text-neutral-200">
                    🔗 LoRA Pool
                    <span className="text-[9px] text-neutral-600 ml-2">{ps.loraPresets.length}</span>
                  </h2>
                  <button onClick={() => setShowLoraPool(true)}
                    className="btn bg-accent text-white text-[10px] px-3 py-1.5 flex items-center gap-1">
                    <Plus size={10} /> Manage
                  </button>
                </div>
                <p className="text-[9px] text-neutral-600">App-wide LoRA presets. Link them to generation presets. Smart LoRA reads descriptions to auto-select.</p>
                {ps.loraPresets.length === 0 ? (
                  <div className="bg-bg-800 rounded-xl border border-dashed border-surface-border p-8 text-center">
                    <p className="text-[11px] text-neutral-500 mb-1">No LoRA presets yet</p>
                    <button onClick={() => setShowLoraPool(true)} className="text-[10px] text-accent hover:underline">Create one →</button>
                  </div>
                ) : (
                  <div className="grid grid-cols-2 gap-3">
                    {ps.loraPresets.map(l => (
                      <div key={l.id} className="bg-bg-700 rounded-lg border border-surface-border p-3">
                        <div className="flex items-start justify-between mb-1">
                          <span className="text-[11px] font-semibold text-neutral-200">{l.name}</span>
                          <button onClick={() => { setEditingPoolLora({ ...l }); setShowLoraPool(true); }}
                            className="text-[9px] text-neutral-500 hover:text-accent">Edit</button>
                        </div>
                        <p className="text-[9px] text-neutral-400 mb-1.5 line-clamp-2">{l.description || 'No description'}</p>
                        <div className="flex gap-1 mb-1">
                          <span className={`text-[7px] px-1 py-0.5 rounded ${l.isDual ? 'bg-amber-500/20 text-amber-400' : 'bg-accent/20 text-accent'}`}>
                            {l.isDual ? 'Dual H/L' : 'Single'}
                          </span>
                          {l.tags?.map(t => <span key={t} className="text-[7px] px-1 py-0.5 rounded bg-neutral-600/30 text-neutral-400">{t}</span>)}
                        </div>
                        <div className="text-[8px] text-neutral-500">
                          {l.isDual ? (
                            <>{l.high?.file && <span>H: {l.high.file.split(/[/\\]/).pop()} </span>}{l.low?.file && <span>L: {l.low.file.split(/[/\\]/).pop()}</span>}</>
                          ) : (
                            l.single?.file && <span>{l.single.file.split(/[/\\]/).pop()} @ {l.single.strength}</span>
                          )}
                        </div>
                        {(() => {
                          const linked = ps.presets.filter(p => p.linkedLoraIds?.includes(l.id));
                          return linked.length > 0 && (
                            <div className="mt-1.5 flex items-center gap-1 flex-wrap">
                              <span className="text-[7px] text-neutral-600">Linked:</span>
                              {linked.map(p => <span key={p.id} className="text-[7px] bg-accent/10 text-accent px-1 rounded">{p.name}</span>)}
                            </div>
                          );
                        })()}
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}

            {/* ── Director LoRA Section ── */}
            {activeSection === 'directorLora' && (
              <>
                <div className="flex items-center justify-between">
                  <h2 className="text-sm font-semibold text-neutral-200">
                    🎬 Director LoRAs
                    <span className="text-[9px] text-neutral-600 ml-2">{ds.loraPresets.length}</span>
                  </h2>
                  <button onClick={() => setShowLoraOverlay(true)}
                    className="btn bg-accent text-white text-[10px] px-3 py-1.5 flex items-center gap-1">
                    <Plus size={10} /> Manage
                  </button>
                </div>
                <p className="text-[9px] text-neutral-600">Wan 2.2 dual HIGH/LOW LoRAs for the AI Director pipeline. Smart LoRA picks per segment.</p>
                {ds.loraPresets.length === 0 ? (
                  <div className="bg-bg-800 rounded-xl border border-dashed border-surface-border p-8 text-center">
                    <p className="text-[11px] text-neutral-500 mb-1">No Director LoRA presets</p>
                    <button onClick={() => setShowLoraOverlay(true)} className="text-[10px] text-accent hover:underline">Create one →</button>
                  </div>
                ) : (
                  <div className="grid grid-cols-2 gap-3">
                    {ds.loraPresets.map(p => (
                      <div key={p.id} className="bg-bg-700 rounded-lg border border-surface-border p-3">
                        <div className="flex items-start justify-between mb-1">
                          <span className="text-[11px] font-semibold text-neutral-200">{p.name}</span>
                          <button onClick={() => { setEditingLora({ ...p }); setShowLoraOverlay(true); }}
                            className="text-[9px] text-neutral-500 hover:text-accent">Edit</button>
                        </div>
                        <p className="text-[9px] text-neutral-400 mb-1">{p.description || 'No description'}</p>
                        <div className="flex gap-1">
                          <span className={`text-[7px] px-1 py-0.5 rounded ${p.target === 'image' ? 'bg-blue-500/20 text-blue-400' : 'bg-emerald-500/20 text-emerald-400'}`}>{p.target}</span>
                          <span className={`text-[7px] px-1 py-0.5 rounded ${p.engine === 'wan22' ? 'bg-amber-500/20 text-amber-400' : 'bg-neutral-600/30 text-neutral-400'}`}>{p.engine === 'wan22' ? 'Wan' : p.engine}</span>
                          <span className={`text-[7px] px-1 py-0.5 rounded ${p.scope === 'global' ? 'bg-amber-500/20 text-amber-400' : 'bg-violet-500/20 text-violet-400'}`}>{p.scope}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}

            {/* ── Settings Section ── */}
            {activeSection === 'settings' && (
              <>
                <h2 className="text-sm font-semibold text-neutral-200">⚙️ Options</h2>

                {/* Required Family Models */}
                {familiesWithRequired.length > 0 && (
                  <div>
                    <h3 className="text-[10px] font-semibold text-neutral-400 mb-2">Required Family Models</h3>
                    <div className="space-y-3">
                      {familiesWithRequired.map(([fKey, fDef]) => (
                        <div key={fKey} className="bg-bg-800 rounded-lg border border-surface-border p-3 space-y-2">
                          <span className="text-[10px] font-semibold text-neutral-300">{fDef.label}</span>
                          {fDef.required.map(r => (
                            <div key={r.key}>
                              <label className="text-[8px] text-neutral-500 block mb-0.5">{r.label}</label>
                              <ModelField value={ps.getRequiredModels(fKey)?.[r.key] || ''} scanFolder={r.scanFolder}
                                onChange={v => ps.setRequiredModel(fKey, r.key, v)} placeholder={r.label} />
                            </div>
                          ))}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Video Preset Mode */}
                <div className="bg-bg-800 rounded-lg border border-surface-border p-3">
                  <div className="flex items-center justify-between">
                    <label className="text-[10px] font-semibold text-neutral-300">Separate I2V + Extend Presets</label>
                    <button onClick={() => ps.setSeparateVideoPresets(!ps.separateVideoPresets)}
                      className={`w-9 h-5 rounded-full transition-colors ${ps.separateVideoPresets ? 'bg-accent' : 'bg-bg-600'}`}>
                      <div className={`w-3.5 h-3.5 rounded-full bg-white transition-transform mx-0.5 ${ps.separateVideoPresets ? 'translate-x-4' : 'translate-x-0'}`} />
                    </button>
                  </div>
                  <p className="text-[8px] text-neutral-500 mt-1">When on, Director shows two dropdowns — one for I2V and one for video extending</p>
                </div>
              </>
            )}
          </>
        )}
      </div>

      {/* Director LoRA Overlay */}
      {showLoraOverlay && (
        <div className="fixed inset-0 bg-black/80 z-50 flex items-center justify-center p-8">
          <div className="bg-bg-800 rounded-xl border border-surface-border w-full max-w-3xl max-h-[80vh] flex flex-col">
            <div className="flex items-center justify-between px-4 py-3 border-b border-surface-border">
              <span className="text-sm font-semibold">Director LoRA Presets ({ds.loraPresets.length})</span>
              <div className="flex gap-2">
                <button onClick={() => setEditingLora({ name: '', description: '', target: 'video', engine: 'wan22', scope: 'global', loraHigh: { file: '', strength: 1.0 }, loraLow: { file: '', strength: 1.0 }, tags: [] })}
                  className="btn bg-accent text-white text-[10px] px-3 py-1"><Plus size={10} className="inline -mt-0.5" /> New</button>
                <button onClick={() => { setShowLoraOverlay(false); setEditingLora(null); }}><X size={16} className="text-neutral-500 hover:text-white" /></button>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto p-4 space-y-3">
              {ds.loraPresets.length === 0 && !editingLora && (
                <div className="text-center py-8">
                  <p className="text-neutral-500 text-sm mb-2">No LoRA presets yet</p>
                  <p className="text-neutral-600 text-[10px] max-w-md mx-auto">Create presets with descriptions. The VLM reads these to choose the best LoRAs for each generation.</p>
                </div>
              )}
              {ds.loraPresets.map(p => (
                <div key={p.id} className="bg-bg-700 rounded-lg border border-surface-border p-3">
                  <div className="flex items-start justify-between mb-1">
                    <div>
                      <span className="text-[11px] font-semibold text-neutral-200">{p.name}</span>
                      <div className="flex gap-1 mt-0.5">
                        <span className={`text-[7px] px-1 py-0.5 rounded ${p.target === 'image' ? 'bg-blue-500/20 text-blue-400' : 'bg-emerald-500/20 text-emerald-400'}`}>{p.target}</span>
                        <span className={`text-[7px] px-1 py-0.5 rounded ${p.engine === 'wan22' ? 'bg-amber-500/20 text-amber-400' : p.engine === 'ltx23' ? 'bg-cyan-500/20 text-cyan-400' : 'bg-neutral-600/30 text-neutral-400'}`}>{p.engine === 'wan22' ? 'Wan' : p.engine === 'ltx23' ? 'LTX' : 'Any'}</span>
                        <span className={`text-[7px] px-1 py-0.5 rounded ${p.scope === 'global' ? 'bg-amber-500/20 text-amber-400' : 'bg-violet-500/20 text-violet-400'}`}>{p.scope}</span>
                      </div>
                    </div>
                    <div className="flex gap-1">
                      <button onClick={() => setEditingLora({ ...p })} className="text-[9px] text-neutral-500 hover:text-accent">Edit</button>
                      <button onClick={() => ds.removeLoraPreset(p.id)} className="text-[9px] text-neutral-500 hover:text-red-400">Delete</button>
                    </div>
                  </div>
                  <p className="text-[9px] text-neutral-400 mb-1">{p.description || 'No description'}</p>
                  <div className="text-[8px] text-neutral-500 space-y-0.5">
                    {p.loraHigh?.file && <div>High: <span className="text-neutral-400">{p.loraHigh.file.split(/[/\\]/).pop()}</span> @ {p.loraHigh.strength}</div>}
                    {p.loraLow?.file && <div>Low: <span className="text-neutral-400">{p.loraLow.file.split(/[/\\]/).pop()}</span> @ {p.loraLow.strength}</div>}
                    {p.tags?.length > 0 && <div>Tags: {p.tags.join(', ')}</div>}
                  </div>
                </div>
              ))}
              {editingLora && (
                <div className="bg-bg-800 rounded-lg border-2 border-accent/50 p-4 space-y-3">
                  <span className="text-[10px] font-semibold text-accent">{editingLora.id ? 'Edit Preset' : 'New Preset'}</span>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="text-[9px] text-neutral-500 block mb-0.5">Name</label>
                      <input value={editingLora.name} onChange={(e) => setEditingLora({ ...editingLora, name: e.target.value })} className="input-field text-[10px] w-full" placeholder="e.g. Anime Style" />
                    </div>
                    <div>
                      <label className="text-[9px] text-neutral-500 block mb-0.5">Tags (comma-separated)</label>
                      <input value={(editingLora.tags || []).join(', ')} onChange={(e) => setEditingLora({ ...editingLora, tags: e.target.value.split(',').map(t => t.trim()).filter(Boolean) })} className="input-field text-[10px] w-full" placeholder="anime, style" />
                    </div>
                  </div>
                  <div>
                    <label className="text-[9px] text-neutral-500 block mb-0.5">Description (VLM reads this to decide)</label>
                    <textarea value={editingLora.description} onChange={(e) => setEditingLora({ ...editingLora, description: e.target.value })} rows={2} className="input-field text-[9px] resize-none w-full" placeholder="What this LoRA does..." />
                  </div>
                  <div className="grid grid-cols-3 gap-3">
                    <div>
                      <label className="text-[9px] text-neutral-500 block mb-0.5">Target</label>
                      <div className="flex gap-1">
                        <button onClick={() => setEditingLora({ ...editingLora, target: 'image' })} className={`flex-1 text-[9px] py-1 rounded ${editingLora.target === 'image' ? 'bg-blue-500 text-white' : 'bg-bg-700 text-neutral-500'}`}>Image</button>
                        <button onClick={() => setEditingLora({ ...editingLora, target: 'video' })} className={`flex-1 text-[9px] py-1 rounded ${editingLora.target === 'video' ? 'bg-emerald-500 text-white' : 'bg-bg-700 text-neutral-500'}`}>Video</button>
                      </div>
                    </div>
                    <div>
                      <label className="text-[9px] text-neutral-500 block mb-0.5">Engine</label>
                      <div className="flex gap-1">
                        {['wan22', 'ltx23', 'any'].map(eng => (
                          <button key={eng} onClick={() => setEditingLora({ ...editingLora, engine: eng })} className={`flex-1 text-[8px] py-1 rounded ${editingLora.engine === eng ? 'bg-accent text-white' : 'bg-bg-700 text-neutral-500'}`}>{eng === 'wan22' ? 'Wan' : eng === 'ltx23' ? 'LTX' : 'Any'}</button>
                        ))}
                      </div>
                    </div>
                    <div>
                      <label className="text-[9px] text-neutral-500 block mb-0.5">Scope</label>
                      <div className="flex gap-1">
                        <button onClick={() => setEditingLora({ ...editingLora, scope: 'global' })} className={`flex-1 text-[8px] py-1 rounded ${editingLora.scope === 'global' ? 'bg-amber-500 text-white' : 'bg-bg-700 text-neutral-500'}`}>Global</button>
                        <button onClick={() => setEditingLora({ ...editingLora, scope: 'per-segment' })} className={`flex-1 text-[8px] py-1 rounded ${editingLora.scope === 'per-segment' ? 'bg-violet-500 text-white' : 'bg-bg-700 text-neutral-500'}`}>Per-Seg</button>
                      </div>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="text-[9px] text-neutral-500 block mb-0.5">High Model LoRA</label>
                      <ModelField value={editingLora.loraHigh?.file || ''} scanFolder="loras" placeholder="Select HIGH LoRA..."
                        onChange={(v) => setEditingLora({ ...editingLora, loraHigh: { ...editingLora.loraHigh, file: v } })} />
                      <div className="flex items-center gap-1 mt-1">
                        <span className="text-[8px] text-neutral-600 shrink-0">Str:</span>
                        <input type="number" step="0.05" min="0" max="2" value={editingLora.loraHigh?.strength ?? 1.0}
                          onChange={(e) => setEditingLora({ ...editingLora, loraHigh: { ...editingLora.loraHigh, strength: parseFloat(e.target.value) || 1.0 } })}
                          className="input-field text-[9px] w-full" />
                      </div>
                    </div>
                    <div>
                      <label className="text-[9px] text-neutral-500 block mb-0.5">Low Model LoRA</label>
                      <ModelField value={editingLora.loraLow?.file || ''} scanFolder="loras" placeholder="Select LOW LoRA..."
                        onChange={(v) => setEditingLora({ ...editingLora, loraLow: { ...editingLora.loraLow, file: v } })} />
                      <div className="flex items-center gap-1 mt-1">
                        <span className="text-[8px] text-neutral-600 shrink-0">Str:</span>
                        <input type="number" step="0.05" min="0" max="2" value={editingLora.loraLow?.strength ?? 1.0}
                          onChange={(e) => setEditingLora({ ...editingLora, loraLow: { ...editingLora.loraLow, strength: parseFloat(e.target.value) || 1.0 } })}
                          className="input-field text-[9px] w-full" />
                      </div>
                    </div>
                  </div>
                  <div className="flex gap-2 justify-end">
                    <button onClick={() => setEditingLora(null)} className="btn btn-ghost text-[10px] px-3 py-1 border border-surface-border">Cancel</button>
                    <button disabled={!editingLora.name} onClick={() => {
                      if (editingLora.id) ds.updateLoraPreset(editingLora.id, editingLora);
                      else ds.addLoraPreset(editingLora);
                      setEditingLora(null);
                    }} className="btn bg-accent text-white text-[10px] px-4 py-1 disabled:opacity-30">{editingLora.id ? 'Update' : 'Create'}</button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* LoRA Pool Overlay */}
      {showLoraPool && (
        <div className="fixed inset-0 bg-black/80 z-50 flex items-center justify-center p-8">
          <div className="bg-bg-800 rounded-xl border border-surface-border w-full max-w-3xl max-h-[80vh] flex flex-col">
            <div className="flex items-center justify-between px-4 py-3 border-b border-surface-border">
              <span className="text-sm font-semibold">LoRA Pool ({ps.loraPresets.length})</span>
              <div className="flex gap-2">
                <button onClick={() => setEditingPoolLora({ name: '', description: '', tags: [], isDual: false, single: { file: '', strength: 0.8 }, high: { file: '', strength: 1.0 }, low: { file: '', strength: 1.0 } })}
                  className="btn bg-accent text-white text-[10px] px-3 py-1"><Plus size={10} className="inline -mt-0.5" /> New</button>
                <button onClick={() => { setShowLoraPool(false); setEditingPoolLora(null); }}><X size={16} className="text-neutral-500 hover:text-white" /></button>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto p-4 space-y-3">
              {ps.loraPresets.length === 0 && !editingPoolLora && (
                <div className="text-center py-8">
                  <p className="text-neutral-500 text-sm mb-2">No LoRA presets yet</p>
                  <p className="text-neutral-600 text-[10px] max-w-md mx-auto">Create LoRA presets with descriptions, then link them to any generation preset. Smart LoRA reads descriptions to auto-select.</p>
                </div>
              )}
              {ps.loraPresets.map(l => (
                <div key={l.id} className="bg-bg-700 rounded-lg border border-surface-border p-3">
                  <div className="flex items-start justify-between mb-1">
                    <div>
                      <span className="text-[11px] font-semibold text-neutral-200">{l.name}</span>
                      <div className="flex gap-1 mt-0.5">
                        <span className={`text-[7px] px-1 py-0.5 rounded ${l.isDual ? 'bg-amber-500/20 text-amber-400' : 'bg-accent/20 text-accent'}`}>{l.isDual ? 'Dual H/L' : 'Single'}</span>
                        {l.tags?.map(t => <span key={t} className="text-[7px] px-1 py-0.5 rounded bg-neutral-600/30 text-neutral-400">{t}</span>)}
                      </div>
                    </div>
                    <div className="flex gap-1">
                      <button onClick={() => setEditingPoolLora({ ...l })} className="text-[9px] text-neutral-500 hover:text-accent">Edit</button>
                      <button onClick={() => ps.deleteLoraPreset(l.id)} className="text-[9px] text-neutral-500 hover:text-red-400">Delete</button>
                    </div>
                  </div>
                  <p className="text-[9px] text-neutral-400 mb-1">{l.description || 'No description'}</p>
                  <div className="text-[8px] text-neutral-500 space-y-0.5">
                    {l.isDual ? (
                      <>
                        {l.high?.file && <div>High: <span className="text-neutral-400">{l.high.file.split(/[/\\]/).pop()}</span> @ {l.high.strength}</div>}
                        {l.low?.file && <div>Low: <span className="text-neutral-400">{l.low.file.split(/[/\\]/).pop()}</span> @ {l.low.strength}</div>}
                      </>
                    ) : (
                      l.single?.file && <div>File: <span className="text-neutral-400">{l.single.file.split(/[/\\]/).pop()}</span> @ {l.single.strength}</div>
                    )}
                  </div>
                  {/* Linked presets — read only */}
                  {(() => {
                    const linked = ps.presets.filter(p => p.linkedLoraIds?.includes(l.id));
                    return linked.length > 0 && (
                      <div className="mt-1.5 flex items-center gap-1 flex-wrap">
                        <span className="text-[7px] text-neutral-600">Linked:</span>
                        {linked.map(p => <span key={p.id} className="text-[7px] bg-accent/10 text-accent px-1 rounded">{p.name}</span>)}
                      </div>
                    );
                  })()}
                </div>
              ))}
              {editingPoolLora && (
                <div className="bg-bg-800 rounded-lg border-2 border-accent/50 p-4 space-y-3">
                  <span className="text-[10px] font-semibold text-accent">{editingPoolLora.id ? 'Edit LoRA' : 'New LoRA'}</span>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="text-[9px] text-neutral-500 block mb-0.5">Name</label>
                      <input value={editingPoolLora.name} onChange={(e) => setEditingPoolLora({ ...editingPoolLora, name: e.target.value })} className="input-field text-[10px] w-full" placeholder="e.g. Anime Style" />
                    </div>
                    <div>
                      <label className="text-[9px] text-neutral-500 block mb-0.5">Tags (comma-separated)</label>
                      <input value={(editingPoolLora.tags || []).join(', ')} onChange={(e) => setEditingPoolLora({ ...editingPoolLora, tags: e.target.value.split(',').map(t => t.trim()).filter(Boolean) })} className="input-field text-[10px] w-full" placeholder="anime, style" />
                    </div>
                  </div>
                  <div>
                    <label className="text-[9px] text-neutral-500 block mb-0.5">Description (Smart LoRA reads this)</label>
                    <textarea value={editingPoolLora.description} onChange={(e) => setEditingPoolLora({ ...editingPoolLora, description: e.target.value })} rows={2} className="input-field text-[9px] resize-none w-full" placeholder="What this LoRA does, when to use it..." />
                  </div>
                  <div>
                    <label className="text-[9px] text-neutral-500 block mb-1">Mode</label>
                    <div className="flex gap-1">
                      <button onClick={() => setEditingPoolLora({ ...editingPoolLora, isDual: false })} className={`flex-1 text-[9px] py-1 rounded ${!editingPoolLora.isDual ? 'bg-accent text-white' : 'bg-bg-700 text-neutral-500'}`}>Single File</button>
                      <button onClick={() => setEditingPoolLora({ ...editingPoolLora, isDual: true })} className={`flex-1 text-[9px] py-1 rounded ${editingPoolLora.isDual ? 'bg-amber-500 text-white' : 'bg-bg-700 text-neutral-500'}`}>Dual HIGH/LOW</button>
                    </div>
                  </div>
                  {editingPoolLora.isDual ? (
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="text-[9px] text-neutral-500 block mb-0.5">HIGH LoRA</label>
                        <ModelField value={editingPoolLora.high?.file || ''} scanFolder="loras" placeholder="Select HIGH LoRA..."
                          onChange={(v) => setEditingPoolLora({ ...editingPoolLora, high: { ...editingPoolLora.high, file: v } })} />
                        <div className="flex items-center gap-1 mt-1">
                          <span className="text-[8px] text-neutral-600 shrink-0">Str:</span>
                          <input type="number" step="0.05" min="0" max="2" value={editingPoolLora.high?.strength ?? 1.0}
                            onChange={(e) => setEditingPoolLora({ ...editingPoolLora, high: { ...editingPoolLora.high, strength: parseFloat(e.target.value) || 1.0 } })}
                            className="input-field text-[9px] w-full" />
                        </div>
                      </div>
                      <div>
                        <label className="text-[9px] text-neutral-500 block mb-0.5">LOW LoRA</label>
                        <ModelField value={editingPoolLora.low?.file || ''} scanFolder="loras" placeholder="Select LOW LoRA..."
                          onChange={(v) => setEditingPoolLora({ ...editingPoolLora, low: { ...editingPoolLora.low, file: v } })} />
                        <div className="flex items-center gap-1 mt-1">
                          <span className="text-[8px] text-neutral-600 shrink-0">Str:</span>
                          <input type="number" step="0.05" min="0" max="2" value={editingPoolLora.low?.strength ?? 1.0}
                            onChange={(e) => setEditingPoolLora({ ...editingPoolLora, low: { ...editingPoolLora.low, strength: parseFloat(e.target.value) || 1.0 } })}
                            className="input-field text-[9px] w-full" />
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div>
                      <label className="text-[9px] text-neutral-500 block mb-0.5">LoRA File</label>
                      <ModelField value={editingPoolLora.single?.file || ''} scanFolder="loras" placeholder="Select LoRA..."
                        onChange={(v) => setEditingPoolLora({ ...editingPoolLora, single: { ...editingPoolLora.single, file: v } })} />
                      <div className="flex items-center gap-1 mt-1">
                        <span className="text-[8px] text-neutral-600 shrink-0">Strength:</span>
                        <input type="number" step="0.05" min="0" max="2" value={editingPoolLora.single?.strength ?? 0.8}
                          onChange={(e) => setEditingPoolLora({ ...editingPoolLora, single: { ...editingPoolLora.single, strength: parseFloat(e.target.value) || 0.8 } })}
                          className="input-field text-[9px] w-full" />
                      </div>
                    </div>
                  )}
                  {/* Link to Presets */}
                  <div>
                    <label className="text-[9px] text-neutral-500 block mb-1">Link to Presets</label>
                    {/* Show linked presets as removable tags */}
                    {(() => {
                      const linkIds = editingPoolLora.id
                        ? ps.presets.filter(p => (p.linkedLoraIds || []).includes(editingPoolLora.id)).map(p => p.id)
                        : (editingPoolLora._linkTo || []);
                      const filterFamily = editingPoolLora._filterFamily || '';
                      const available = ps.presets
                        .filter(p => p.type !== 'vlm' && p.type !== 'video' && !linkIds.includes(p.id))
                        .filter(p => !filterFamily || (p.modelType || '') === filterFamily);
                      return (
                        <>
                          {linkIds.length > 0 && (
                            <div className="flex flex-wrap gap-1 mb-1.5">
                              {linkIds.map(pid => {
                                const p = ps.presets.find(x => x.id === pid);
                                if (!p) return null;
                                const fDef = getFamily(p.family);
                                return (
                                  <span key={pid} className="inline-flex items-center gap-1 text-[8px] bg-accent/10 text-accent px-1.5 py-0.5 rounded">
                                    {p.name} <span className="text-neutral-500">({fDef?.label || p.family})</span>
                                    <button onClick={() => {
                                      if (editingPoolLora.id) ps.unlinkLora(pid, editingPoolLora.id);
                                      else setEditingPoolLora({ ...editingPoolLora, _linkTo: (editingPoolLora._linkTo || []).filter(id => id !== pid) });
                                    }} className="hover:text-red-400"><X size={7} /></button>
                                  </span>
                                );
                              })}
                            </div>
                          )}
                          <div className="flex gap-1.5">
                            <select value={filterFamily}
                              onChange={e => setEditingPoolLora({ ...editingPoolLora, _filterFamily: e.target.value })}
                              className="select-field text-[9px] flex-1">
                              <option value="">Select type...</option>
                              <option value="sdxl">SDXL</option>
                              <option value="pony">Pony</option>
                              <option value="illustrious">Illustrious</option>
                              <option value="qwen_edit">Qwen Edit</option>
                            </select>
                            <select value="" disabled={!filterFamily} onChange={e => {
                              if (!e.target.value) return;
                              if (editingPoolLora.id) ps.linkLora(e.target.value, editingPoolLora.id);
                              else setEditingPoolLora({ ...editingPoolLora, _linkTo: [...(editingPoolLora._linkTo || []), e.target.value] });
                            }} className="select-field text-[9px] flex-1 disabled:opacity-30">
                              <option value="">{filterFamily ? '+ Link to a preset...' : 'Select type first'}</option>
                              {available.map(p => (
                                <option key={p.id} value={p.id}>{p.name}</option>
                              ))}
                            </select>
                          </div>
                        </>
                      );
                    })()}
                  </div>
                  <div className="flex gap-2 justify-end">
                    <button onClick={() => setEditingPoolLora(null)} className="btn btn-ghost text-[10px] px-3 py-1 border border-surface-border">Cancel</button>
                    <button disabled={!editingPoolLora.name} onClick={() => {
                      if (editingPoolLora.id) {
                        ps.updateLoraPreset(editingPoolLora.id, editingPoolLora);
                      } else {
                        const linkTo = editingPoolLora._linkTo || [];
                        const { _linkTo, ...loraData } = editingPoolLora;
                        ps.addLoraPreset(loraData);
                        const newId = usePresetStore.getState().loraPresets.slice(-1)[0]?.id;
                        if (newId) linkTo.forEach(pid => ps.linkLora(pid, newId));
                      }
                      setEditingPoolLora(null);
                    }} className="btn bg-accent text-white text-[10px] px-4 py-1 disabled:opacity-30">{editingPoolLora.id ? 'Update' : 'Create'}</button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Combine Overlay */}
      {showCombine && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-8">
          <div className="bg-bg-800 rounded-xl border border-surface-border w-full max-w-md p-5 space-y-4">
            <div className="flex items-center justify-between">
              <span className="text-sm font-semibold">Combine Presets</span>
              <button onClick={() => setShowCombine(false)}><X size={14} className="text-neutral-500 hover:text-white" /></button>
            </div>
            <p className="text-[9px] text-neutral-500">Select a Fast and Quality preset of the same type to combine. Models, LoRAs, and model type are shared. Each mode keeps its own settings and always-on LoRAs.</p>
            <div className="space-y-2">
              <div>
                <label className="text-[9px] text-amber-400 block mb-0.5">⚡ Fast Preset</label>
                <select value={combineFastId} onChange={e => setCombineFastId(e.target.value)} className="select-field text-[10px] w-full">
                  <option value="">Select fast preset...</option>
                  {ps.presets.filter(p => (p.mode === 'fast' || p.mode === 'both') && p.type !== 'vlm' && p.mode !== 'combined').map(p => (
                    <option key={p.id} value={p.id}>{p.name} ({getFamily(p.family)?.label || p.family})</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-[9px] text-violet-400 block mb-0.5">🎨 Quality Preset</label>
                <select value={combineQualityId} onChange={e => setCombineQualityId(e.target.value)} className="select-field text-[10px] w-full">
                  <option value="">Select quality preset...</option>
                  {ps.presets.filter(p => (p.mode === 'quality' || p.mode === 'both') && p.type !== 'vlm' && p.mode !== 'combined' && p.id !== combineFastId).map(p => (
                    <option key={p.id} value={p.id}>{p.name} ({getFamily(p.family)?.label || p.family})</option>
                  ))}
                </select>
              </div>
              {combineFastId && combineQualityId && (() => {
                const fast = ps.presets.find(p => p.id === combineFastId);
                const qual = ps.presets.find(p => p.id === combineQualityId);
                if (fast?.family !== qual?.family) return (
                  <div className="bg-red-500/10 border border-red-500/30 rounded px-3 py-2 text-[9px] text-red-400">
                    Different families — can only combine presets of the same family.
                  </div>
                );
                return null;
              })()}
            </div>
            <div className="flex justify-end gap-2">
              <button onClick={() => setShowCombine(false)} className="btn btn-ghost text-[10px] px-3 py-1">Cancel</button>
              <button disabled={!combineFastId || !combineQualityId || (() => {
                const fast = ps.presets.find(p => p.id === combineFastId);
                const qual = ps.presets.find(p => p.id === combineQualityId);
                return fast?.family !== qual?.family;
              })()} onClick={() => {
                ps.combinePresets(combineFastId, combineQualityId);
                setShowCombine(false);
              }} className="btn bg-accent text-white text-[10px] px-4 py-1 disabled:opacity-30">
                Combine
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Confirmation */}
      {confirmDelete && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center">
          <div className="bg-bg-800 rounded-xl border border-surface-border p-4 max-w-sm">
            <p className="text-sm mb-3">Delete this preset?</p>
            <div className="flex justify-end gap-2">
              <button onClick={() => setConfirmDelete(null)} className="btn btn-ghost text-[10px] px-3 py-1">Cancel</button>
              <button onClick={() => handleDelete(confirmDelete)} className="btn bg-red-600 text-white text-[10px] px-3 py-1">Delete</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
