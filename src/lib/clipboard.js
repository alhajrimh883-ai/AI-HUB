// Shared clipboard helper. In Electron renderers, navigator.clipboard.writeText
// is unreliable (silently rejects under non-secure origins / certain
// webPreferences). Route through Electron's native clipboard module via IPC
// when available, fall back to the DOM API for browser/test contexts.
//
// Returns a Promise<boolean> — true if the write succeeded, false otherwise.

export async function copyToClipboard(text) {
  const value = String(text ?? '');
  if (!value) return false;

  // Prefer Electron's native clipboard (most reliable).
  if (typeof window !== 'undefined' && window.electronAPI?.clipboardWrite) {
    try {
      const res = await window.electronAPI.clipboardWrite(value);
      if (res?.ok) return true;
    } catch { /* fall through to navigator */ }
  }

  // Fall back to the DOM Clipboard API (works in browsers + some Electron).
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try { await navigator.clipboard.writeText(value); return true; }
    catch { /* give up */ }
  }

  return false;
}
