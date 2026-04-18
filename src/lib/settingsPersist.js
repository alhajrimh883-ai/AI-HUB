/**
 * Global Settings Persistence
 * 
 * Single save timer shared across ALL stores to prevent race conditions.
 * Each store registers its keys via `registerSave()`, and the global timer
 * collects all pending changes before doing one atomic read-merge-write.
 */

let saveTimer = null;
let pendingWrites = {}; // accumulates key-value pairs from all stores

/**
 * Queue a settings write. Multiple calls within 500ms are merged into one atomic save.
 * @param {Object} keyValues - key-value pairs to save
 */
export function saveSettings(keyValues) {
  Object.assign(pendingWrites, keyValues);
  if (!window.electronAPI) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    const toWrite = { ...pendingWrites };
    pendingWrites = {};
    try {
      const cur = await window.electronAPI.loadSettings() || {};
      Object.assign(cur, toWrite);
      window.electronAPI.saveSettings(cur);
    } catch (e) {
      console.error('[Settings] Save failed:', e);
    }
  }, 500);
}
