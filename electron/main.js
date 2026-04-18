const { app, BrowserWindow, ipcMain, dialog, session, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const os = require('os');
const { execSync, execFileSync, spawn } = require('child_process');

// ── Chromium command-line switches ────────────────────────────────────
// Must be set BEFORE app.whenReady(). These specifically work around
// getUserMedia renderer crashes on Windows Electron builds: the first skips
// Chromium's internal media-permission UI (which has been observed to crash
// the renderer when invoked from an Electron origin), the second disables a
// WebRTC feature that interacts badly with localhost apps.
app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
app.commandLine.appendSwitch('disable-features', 'WebRtcHideLocalIpsWithMdns');

const DEFAULT_COMFYUI = '';
let comfyuiPath = DEFAULT_COMFYUI;
let modelsPath = '';
let ffmpegPath = null; // resolved on startup

const SETTINGS_FILE = path.join(app.getPath('userData'), 'ai-hub-settings.json');
const FFMPEG_DIR = path.join(app.getPath('userData'), 'ffmpeg');
const FFMPEG_EXE = path.join(FFMPEG_DIR, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');

// ── FFmpeg Management ──
function getFFmpegPath() {
  if (ffmpegPath) return ffmpegPath;

  // 1. App folder (auto-installed)
  if (fs.existsSync(FFMPEG_EXE)) { ffmpegPath = FFMPEG_EXE; return ffmpegPath; }

  // 2. ffmpeg-static npm package
  try { ffmpegPath = require('ffmpeg-static'); return ffmpegPath; } catch {}

  // 3. System PATH
  try {
    execSync(process.platform === 'win32' ? 'where ffmpeg' : 'which ffmpeg', { stdio: 'pipe' });
    ffmpegPath = 'ffmpeg';
    return ffmpegPath;
  } catch {}

  return null;
}

// Download file following redirects
function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    const get = url.startsWith('https') ? https.get : http.get;
    get(url, { headers: { 'User-Agent': 'WanVideoStudio' } }, (resp) => {
      // Follow redirects
      if (resp.statusCode >= 300 && resp.statusCode < 400 && resp.headers.location) {
        file.close(); fs.unlinkSync(destPath);
        return downloadFile(resp.headers.location, destPath).then(resolve).catch(reject);
      }
      if (resp.statusCode !== 200) { file.close(); fs.unlinkSync(destPath); return reject(new Error(`HTTP ${resp.statusCode}`)); }
      resp.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
    }).on('error', (e) => { file.close(); if (fs.existsSync(destPath)) fs.unlinkSync(destPath); reject(e); });
  });
}

async function ensureFFmpeg(statusCb) {
  // Already found
  if (getFFmpegPath()) return ffmpegPath;

  statusCb?.('Installing ffmpeg...');
  if (!fs.existsSync(FFMPEG_DIR)) fs.mkdirSync(FFMPEG_DIR, { recursive: true });

  try {
    // Download lightweight ffmpeg essentials for Windows
    const zipUrl = 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip';
    const zipPath = path.join(FFMPEG_DIR, 'ffmpeg.zip');

    statusCb?.('Downloading ffmpeg (~70MB)...');
    await downloadFile(zipUrl, zipPath);

    statusCb?.('Extracting ffmpeg...');
    // Extract using PowerShell (Windows 10+)
    execSync(`powershell -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${FFMPEG_DIR}' -Force"`, { timeout: 120000, stdio: 'pipe' });

    // Find ffmpeg.exe in extracted folder (nested in a subfolder)
    const findExe = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { const found = findExe(full); if (found) return found; }
        if (entry.name === 'ffmpeg.exe') return full;
      }
      return null;
    };
    const found = findExe(FFMPEG_DIR);
    if (found && found !== FFMPEG_EXE) {
      fs.copyFileSync(found, FFMPEG_EXE);
    }

    // Cleanup zip and extracted subfolder
    if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
    // Remove extracted subdirectories (keep only ffmpeg.exe)
    for (const entry of fs.readdirSync(FFMPEG_DIR, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        fs.rmSync(path.join(FFMPEG_DIR, entry.name), { recursive: true, force: true });
      }
    }

    if (fs.existsSync(FFMPEG_EXE)) {
      ffmpegPath = FFMPEG_EXE;
      statusCb?.('ffmpeg installed!');
      return ffmpegPath;
    }
    throw new Error('ffmpeg.exe not found after extraction');
  } catch (e) {
    statusCb?.(`ffmpeg install failed: ${e.message}`);
    return null;
  }
}

function getAppDir() {
  return app.isPackaged ? path.dirname(app.getPath('exe')) : path.join(__dirname, '..');
}
function getOutputDir() {
  const d = path.join(getAppDir(), 'output');
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  return d;
}
function getSessionsDir() {
  const d = path.join(getAppDir(), 'output', 'sessions');
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  return d;
}
function getImportsDir() {
  const d = path.join(getAppDir(), 'output', 'imports');
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  return d;
}

/** Validate that a resolved path is inside the expected parent dir */
function isInsideDir(filePath, parentDir) {
  const resolved = path.resolve(filePath);
  const parent = path.resolve(parentDir);
  return resolved.startsWith(parent + path.sep) || resolved === parent;
}

/** Guard: ensure sessionId is a simple safe string */
function validateSessionId(id) {
  if (!id || typeof id !== 'string') throw new Error('Invalid session ID');
  if (/[/\\:*?"<>|]/.test(id) || id.includes('..')) throw new Error('Invalid session ID');
  return id;
}

/** Guard: ensure pkgId is a simple safe string */
function validatePkgId(id) {
  if (!id || typeof id !== 'string') throw new Error('Invalid package ID');
  if (/[/\\:*?"<>|]/.test(id) || id.includes('..')) throw new Error('Invalid package ID');
  return id;
}

/** Safe sanitize a folder name */
function sanitizeName(name) {
  if (!name || typeof name !== 'string') return 'untitled';
  return name.replace(/[/\\:*?"<>|.]/g, '_').substring(0, 100);
}
function loadSettings() {
  try { if (fs.existsSync(SETTINGS_FILE)) return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8')); } catch {}
  return {};
}
function saveSettings(settings) {
  try { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf-8'); return true; } catch { return false; }
}

let mainWindow = null;
let splashWindow = null;

function createSplash() {
  splashWindow = new BrowserWindow({
    width: 420, height: 320,
    frame: false, transparent: false, resizable: false,
    backgroundColor: '#0d0d0d',
    center: true, alwaysOnTop: true,
    webPreferences: {
      preload: path.join(__dirname, 'splashPreload.js'),
      contextIsolation: true, nodeIntegration: false,
    },
  });
  splashWindow.loadFile(path.join(__dirname, 'splash.html'));
  return splashWindow;
}

function splashStatus(msg) {
  if (splashWindow && !splashWindow.isDestroyed()) {
    splashWindow.webContents.send('splash-status', msg);
  }
}

function splashError(msg) {
  if (splashWindow && !splashWindow.isDestroyed()) {
    splashWindow.webContents.send('splash-error', msg);
    splashWindow.setAlwaysOnTop(false); // let user interact
  }
}

function createWindow() {
  const settings = loadSettings();
  if (settings.comfyuiPath) comfyuiPath = settings.comfyuiPath;
  if (settings.modelsPath) modelsPath = settings.modelsPath;

  const win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 1200, minHeight: 700,
    backgroundColor: '#0d0d0d',
    frame: false, // fully custom title bar
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, webSecurity: false,
    },
  });
  mainWindow = win;

  // DevTools: F12 or Ctrl+Shift+I
  win.webContents.on('before-input-event', (event, input) => {
    if (input.key === 'F12' || (input.control && input.shift && input.key === 'I')) {
      win.webContents.toggleDevTools();
    }
  });

  // When main window content is ready, show it and close splash
  win.once('ready-to-show', () => {
    if (splashWindow && !splashWindow.isDestroyed()) splashWindow.close();
    splashWindow = null;
    win.show();
    win.focus();
  });

  if (process.argv.includes('--dev') || !app.isPackaged) {
    win.loadURL('http://localhost:5173').catch((err) => {
      splashError(`Failed to connect to dev server:\n\n${err.message}\n\nMake sure Vite is running (npm run dev).`);
    });
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html')).catch((err) => {
      splashError(`Failed to load app:\n\n${err.message}`);
    });
  }
}

/**
 * Forward log messages to the renderer for the in-app Logs panel.
 * @param {'comfyui'|'vlm'|'app'} source
 * @param {string} message
 */
function sendLog(source, message) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('log-message', { source, message, timestamp: Date.now() });
  }
}

// ═══════════════════════════════════════════════════════════
// SESSION MANAGEMENT
// ═══════════════════════════════════════════════════════════

ipcMain.handle('session-create', async (_, name) => {
  const dir = getSessionsDir();
  const id = `sess_${Date.now()}`;
  const sessionDir = path.join(dir, id);
  fs.mkdirSync(sessionDir, { recursive: true });
  const meta = {
    id, name: name || 'Untitled Session',
    created: new Date().toISOString(),
    favorite: false, imageCount: 0,
  };
  fs.writeFileSync(path.join(sessionDir, 'session.json'), JSON.stringify(meta, null, 2));
  const settings = loadSettings();
  settings.lastSessionId = id;
  saveSettings(settings);
  return meta;
});

// Get or create an auto-session for a given tab (Animate, Editor, Long Video)
ipcMain.handle('session-get-or-create', async (_, tabName) => {
  const dir = getSessionsDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  // Search for existing auto-session
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const metaPath = path.join(dir, entry.name, 'session.json');
    if (fs.existsSync(metaPath)) {
      try {
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
        if (meta.autoTab === tabName) return meta;
      } catch {}
    }
  }
  // Create new auto-session
  const id = `sess_auto_${tabName.toLowerCase().replace(/\s+/g, '_')}_${Date.now()}`;
  const sessionDir = path.join(dir, id);
  fs.mkdirSync(sessionDir, { recursive: true });
  const meta = {
    id, name: `${tabName} Outputs`,
    created: new Date().toISOString(),
    favorite: false, imageCount: 0, autoTab: tabName,
  };
  fs.writeFileSync(path.join(sessionDir, 'session.json'), JSON.stringify(meta, null, 2));
  return meta;
});

ipcMain.handle('session-list', async () => {
  const dir = getSessionsDir();
  if (!fs.existsSync(dir)) return [];
  const sessions = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const metaPath = path.join(dir, entry.name, 'session.json');
    if (fs.existsSync(metaPath)) {
      try {
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
        // Count packages (pkg_ dirs) + any legacy loose images
        const entries = fs.readdirSync(path.join(dir, entry.name), { withFileTypes: true });
        const pkgCount = entries.filter(e => e.isDirectory() && e.name.startsWith('pkg_')).length;
        const legacyCount = entries.filter(e => !e.isDirectory() && /\.(png|jpg|jpeg|webp)$/i.test(e.name)).length;
        meta.imageCount = pkgCount + legacyCount;
        sessions.push(meta);
      } catch {}
    }
  }
  sessions.sort((a, b) => {
    if (a.favorite !== b.favorite) return b.favorite ? 1 : -1;
    return new Date(b.created) - new Date(a.created);
  });
  return sessions;
});

ipcMain.handle('session-load', async (_, sessionId) => {
  validateSessionId(sessionId);
  const sessionDir = path.join(getSessionsDir(), sessionId);
  if (!fs.existsSync(sessionDir)) return null;
  const metaPath = path.join(sessionDir, 'session.json');
  const meta = fs.existsSync(metaPath) ? JSON.parse(fs.readFileSync(metaPath, 'utf-8')) : { id: sessionId };
  // Load images sorted by creation time (newest first)
  const imgFiles = fs.readdirSync(sessionDir)
    .filter(f => /\.(png|jpg|jpeg|webp)$/i.test(f))
    .map(f => {
      const filePath = path.join(sessionDir, f);
      const metaSidecar = path.join(sessionDir, `${f}.json`);
      let metadata = null;
      try { if (fs.existsSync(metaSidecar)) metadata = JSON.parse(fs.readFileSync(metaSidecar, 'utf-8')); } catch {}
      return {
        filename: f,
        path: filePath,
        created: fs.statSync(filePath).mtimeMs,
        metadata,
      };
    })
    .sort((a, b) => b.created - a.created);
  // Set as last active
  const settings = loadSettings();
  settings.lastSessionId = sessionId;
  saveSettings(settings);
  return { meta, images: imgFiles };
});

ipcMain.handle('session-update', async (_, sessionId, updates) => {
  validateSessionId(sessionId);
  const metaPath = path.join(getSessionsDir(), sessionId, 'session.json');
  if (!fs.existsSync(metaPath)) return null;
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
  Object.assign(meta, updates);
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
  return meta;
});

ipcMain.handle('session-delete', async (_, sessionId) => {
  validateSessionId(sessionId);
  const sessionDir = path.join(getSessionsDir(), sessionId);
  if (!isInsideDir(sessionDir, getSessionsDir())) return false;
  if (fs.existsSync(sessionDir)) fs.rmSync(sessionDir, { recursive: true, force: true });
  return true;
});

ipcMain.handle('session-save-image', async (_, sessionId, base64, prefix, metadata) => {
  validateSessionId(sessionId);
  const sessionDir = path.join(getSessionsDir(), sessionId);
  if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });
  const ts = Date.now();
  const rand = Math.random().toString(36).substring(2, 6);
  const filename = `${prefix || 'img'}_${ts}_${rand}.png`;
  const filePath = path.join(sessionDir, filename);
  const buffer = Buffer.from(base64, 'base64');
  fs.writeFileSync(filePath, buffer);
  // Save metadata sidecar
  if (metadata) {
    const metaPath = path.join(sessionDir, `${filename}.json`);
    fs.writeFileSync(metaPath, JSON.stringify({ ...metadata, filename, created: Date.now() }, null, 2));
  }
  return { filename, path: filePath, created: Date.now() };
});

ipcMain.handle('session-delete-image', async (_, sessionId, filename) => {
  if (!sessionId || !filename) return false;
  const sessionDir = path.join(getSessionsDir(), sessionId);
  // Safety: only delete files inside the session directory
  const filePath = path.join(sessionDir, filename);
  const metaPath = path.join(sessionDir, `${filename}.json`);
  if (!filePath.startsWith(sessionDir)) return false; // prevent path traversal
  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) fs.unlinkSync(filePath);
  if (fs.existsSync(metaPath) && fs.statSync(metaPath).isFile()) fs.unlinkSync(metaPath);
  return true;
});

ipcMain.handle('session-get-image-path', async (_, sessionId, filename) => {
  validateSessionId(sessionId);
  const result = path.join(getSessionsDir(), sessionId, filename);
  if (!isInsideDir(result, path.join(getSessionsDir(), sessionId))) return null;
  return result;
});

ipcMain.handle('get-last-session-id', async () => {
  const settings = loadSettings();
  return settings.lastSessionId || null;
});

/**
 * Download image from ComfyUI /view endpoint and save to session folder.
 * LEGACY — kept for backward compat, but new code should use pkg-* handlers.
 */
ipcMain.handle('download-comfyui-image', async (_, { filename, subfolder, type, sessionId, prefix, metadata }) => {
  const sessionDir = path.join(getSessionsDir(), sessionId);
  if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });
  const ts = Date.now();
  const rand = Math.random().toString(36).substring(2, 6);
  const saveName = `${prefix || 'img'}_${ts}_${rand}.png`;
  const savePath = path.join(sessionDir, saveName);
  const url = `http://127.0.0.1:8188/view?filename=${encodeURIComponent(filename)}&subfolder=${encodeURIComponent(subfolder || '')}&type=${encodeURIComponent(type || 'temp')}`;
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      if (res.statusCode !== 200) return reject(new Error(`Download failed: ${res.statusCode}`));
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        fs.writeFileSync(savePath, buffer);
        if (metadata) {
          fs.writeFileSync(path.join(sessionDir, `${saveName}.json`), JSON.stringify({ ...metadata, filename: saveName, created: Date.now() }, null, 2));
        }
        resolve({ filename: saveName, path: savePath, created: Date.now() });
      });
      res.on('error', reject);
    }).on('error', reject);
  });
});

ipcMain.handle('download-comfyui-video', async (_, { filename, subfolder, type, sessionId, sourceImage }) => {
  const sessionDir = path.join(getSessionsDir(), sessionId);
  if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });
  const ts = Date.now();
  const rand = Math.random().toString(36).substring(2, 6);
  const saveName = `anim_${ts}_${rand}.mp4`;
  const savePath = path.join(sessionDir, saveName);
  const url = `http://127.0.0.1:8188/view?filename=${encodeURIComponent(filename)}&subfolder=${encodeURIComponent(subfolder || 'video')}&type=${encodeURIComponent(type || 'output')}`;
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      if (res.statusCode !== 200) return reject(new Error(`Video download failed: ${res.statusCode}`));
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        fs.writeFileSync(savePath, Buffer.concat(chunks));
        resolve({ filename: saveName, path: savePath, created: Date.now() });
      });
      res.on('error', reject);
    }).on('error', reject);
  });
});

// ═══════════════════════════════════════════════════════════════════
// PACKAGE SYSTEM
// Each image generation creates a "package" — a folder containing
// the root image + all variants (edits, hires fixes) + all videos.
// ═══════════════════════════════════════════════════════════════════

function downloadComfyBuffer(filename, subfolder, type) {
  const url = `http://127.0.0.1:8188/view?filename=${encodeURIComponent(filename)}&subfolder=${encodeURIComponent(subfolder || '')}&type=${encodeURIComponent(type || 'temp')}`;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { req.destroy(); reject(new Error('Download timeout (30s)')); }, 30000);
    const req = http.get(url, (res) => {
      if (res.statusCode !== 200) { clearTimeout(timeout); return reject(new Error(`Download failed: ${res.statusCode}`)); }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => { clearTimeout(timeout); resolve(Buffer.concat(chunks)); });
      res.on('error', (e) => { clearTimeout(timeout); reject(e); });
    });
    req.on('error', (e) => { clearTimeout(timeout); reject(e); });
  });
}

function generateThumb(imagePath, thumbPath) {
  try {
    const { nativeImage } = require('electron');
    const img = nativeImage.createFromPath(imagePath);
    if (img.isEmpty()) return false;
    const resized = img.resize({ width: 400, quality: 'good' });
    fs.writeFileSync(thumbPath, resized.toJPEG(75));
    return true;
  } catch { return false; }
}

function getPkgDir(sessionId, pkgId) {
  return path.join(getSessionsDir(), sessionId, pkgId);
}

function loadPkg(sessionId, pkgId) {
  const pkgFile = path.join(getPkgDir(sessionId, pkgId), 'pkg.json');
  if (!fs.existsSync(pkgFile)) return null;
  try { return JSON.parse(fs.readFileSync(pkgFile, 'utf-8')); } catch { return null; }
}

function savePkg(sessionId, pkgId, data) {
  const dir = getPkgDir(sessionId, pkgId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'pkg.json'), JSON.stringify(data, null, 2));
}

function enrichPkgPaths(sessionId, pkg) {
  const enriched = JSON.parse(JSON.stringify(pkg)); // deep copy
  const dir = getPkgDir(sessionId, enriched.id);
  const t = Date.now();
  const addPath = (node) => {
    if (node.filename) {
      node.path = path.join(dir, node.filename);
      node.preview = `file:///${node.path.replace(/\\/g, '/')}?t=${t}`;
    }
    if (node.thumbFile) {
      node.thumbPath = path.join(dir, node.thumbFile);
      node.thumb = `file:///${node.thumbPath.replace(/\\/g, '/')}?t=${t}`;
    }
    if (node.videos) {
      for (const v of node.videos) {
        if (v.filename) {
          v.path = path.join(dir, v.filename);
          v.videoUrl = `file:///${v.path.replace(/\\/g, '/')}?t=${t}`;
        }
      }
    }
  };
  if (enriched.root) addPath(enriched.root);
  if (enriched.variants) enriched.variants.forEach(addPath);
  return enriched;
}

// ── Create a package from a local file (for non-studio tabs) ──
ipcMain.handle('pkg-create-from-url', async (_, { sessionId, imageUrl, metadata }) => {
  validateSessionId(sessionId);
  const pkgId = `pkg_${Date.now()}_${Math.random().toString(36).substring(2, 5)}`;
  const dir = getPkgDir(sessionId, pkgId);
  fs.mkdirSync(dir, { recursive: true });

  const rootFile = 'root.png';
  const thumbFile = 'root_thumb.jpg';

  console.log(`[pkg-create-from-url] imageUrl: ${imageUrl?.substring(0, 120)}`);

  try {
    if (imageUrl.startsWith('file:///') || imageUrl.startsWith('file://')) {
      // Local file — strip protocol, cache buster, and decode
      let localPath = decodeURIComponent(imageUrl.replace(/^file:\/\/\/?/, '').split('?')[0]);
      // On Windows, file:///E:/path → E:/path
      if (process.platform === 'win32' && /^\/[A-Za-z]:/.test(localPath)) localPath = localPath.substring(1);
      if (fs.existsSync(localPath)) {
        fs.copyFileSync(localPath, path.join(dir, rootFile));
      } else {
        throw new Error(`Source image not found: ${localPath}`);
      }
    } else if (imageUrl.startsWith('http')) {
      // ComfyUI URL — extract params
      const url = new URL(imageUrl);
      const filename = url.searchParams.get('filename');
      if (!filename) throw new Error('No filename in URL');
      const buffer = await downloadComfyBuffer(
        filename,
        url.searchParams.get('subfolder') || '',
        url.searchParams.get('type') || 'input'
      );
      fs.writeFileSync(path.join(dir, rootFile), buffer);
    } else {
      throw new Error('Unsupported image URL format');
    }
  } catch (err) {
    // Cleanup on failure
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    throw err;
  }

  generateThumb(path.join(dir, rootFile), path.join(dir, thumbFile));
  const pkg = { id: pkgId, created: Date.now(), root: { filename: rootFile, thumbFile, metadata: metadata || {}, videos: [] }, variants: [] };
  savePkg(sessionId, pkgId, pkg);
  return enrichPkgPaths(sessionId, pkg);
});

// ── Create a new package from a ComfyUI image ──
ipcMain.handle('pkg-create', async (_, { sessionId, comfyFilename, comfySubfolder, comfyType, metadata }) => {
  validateSessionId(sessionId);
  const pkgId = `pkg_${Date.now()}_${Math.random().toString(36).substring(2, 5)}`;
  const dir = getPkgDir(sessionId, pkgId);
  fs.mkdirSync(dir, { recursive: true });

  // Download image from ComfyUI
  const buffer = await downloadComfyBuffer(comfyFilename, comfySubfolder, comfyType);
  const rootFile = 'root.png';
  const thumbFile = 'root_thumb.jpg';
  fs.writeFileSync(path.join(dir, rootFile), buffer);
  generateThumb(path.join(dir, rootFile), path.join(dir, thumbFile));

  const pkg = {
    id: pkgId,
    created: Date.now(),
    root: {
      filename: rootFile,
      thumbFile,
      metadata: metadata || {},
      videos: [],
    },
    variants: [],
  };
  savePkg(sessionId, pkgId, pkg);
  return enrichPkgPaths(sessionId, pkg);
});

// ── Add a variant (hires/edit) to a package ──
ipcMain.handle('pkg-add-variant', async (_, { sessionId, pkgId, type, comfyFilename, comfySubfolder, comfyType, settings }) => {
  validateSessionId(sessionId); validatePkgId(pkgId);
  const pkg = loadPkg(sessionId, pkgId);
  if (!pkg) throw new Error('Package not found');

  // Auto-increment using max existing number to avoid collision after deletions
  const existing = pkg.variants.filter(v => v.type === type);
  const maxNum = existing.reduce((max, v) => {
    const m = v.id.match(/_(\d+)$/);
    return m ? Math.max(max, parseInt(m[1], 10)) : max;
  }, 0);
  const num = maxNum + 1;
  const variantId = `${type}_${num}`;
  const variantFile = `${variantId}.png`;
  const thumbFile = `${variantId}_thumb.jpg`;

  const dir = getPkgDir(sessionId, pkgId);
  const buffer = await downloadComfyBuffer(comfyFilename, comfySubfolder, comfyType);
  fs.writeFileSync(path.join(dir, variantFile), buffer);
  generateThumb(path.join(dir, variantFile), path.join(dir, thumbFile));

  const variant = {
    id: variantId,
    type, // 'hires' or 'edit'
    label: `${type === 'hires' ? 'Hires Fix' : 'Edit'} ${num}`,
    filename: variantFile,
    thumbFile,
    settings: settings || {},
    videos: [],
    created: Date.now(),
  };
  pkg.variants.push(variant);
  savePkg(sessionId, pkgId, pkg);
  return { pkg: enrichPkgPaths(sessionId, pkg), variantId };
});

// ── Replace root or variant image ──
ipcMain.handle('pkg-replace-image', async (_, { sessionId, pkgId, nodeId, comfyFilename, comfySubfolder, comfyType }) => {
  validateSessionId(sessionId); validatePkgId(pkgId);
  const pkg = loadPkg(sessionId, pkgId);
  if (!pkg) throw new Error('Package not found');

  const dir = getPkgDir(sessionId, pkgId);
  const buffer = await downloadComfyBuffer(comfyFilename, comfySubfolder, comfyType);

  if (!nodeId || nodeId === 'root') {
    // Replace root
    fs.writeFileSync(path.join(dir, pkg.root.filename), buffer);
    generateThumb(path.join(dir, pkg.root.filename), path.join(dir, pkg.root.thumbFile));
  } else {
    // Replace variant
    const variant = pkg.variants.find(v => v.id === nodeId);
    if (!variant) throw new Error('Variant not found');
    fs.writeFileSync(path.join(dir, variant.filename), buffer);
    generateThumb(path.join(dir, variant.filename), path.join(dir, variant.thumbFile));
  }

  savePkg(sessionId, pkgId, pkg);
  return enrichPkgPaths(sessionId, pkg);
});

// ── Add video to a node (root or variant) ──
ipcMain.handle('pkg-add-video', async (_, { sessionId, pkgId, nodeId, comfyFilename, comfySubfolder, comfyType, videoMeta }) => {
  validateSessionId(sessionId); validatePkgId(pkgId);
  const pkg = loadPkg(sessionId, pkgId);
  if (!pkg) throw new Error('Package not found');

  const dir = getPkgDir(sessionId, pkgId);
  const ts = Date.now();
  const rand = Math.random().toString(36).substring(2, 5);
  const videoFile = `video_${ts}_${rand}.mp4`;
  const buffer = await downloadComfyBuffer(comfyFilename, comfySubfolder, comfyType);
  fs.writeFileSync(path.join(dir, videoFile), buffer);

  const entry = {
    filename: videoFile,
    created: ts,
    ...(videoMeta || {}),
  };

  // Find target node
  if (!nodeId || nodeId === 'root') {
    pkg.root.videos.push(entry);
  } else {
    const variant = pkg.variants.find(v => v.id === nodeId);
    if (!variant) throw new Error('Variant not found');
    variant.videos.push(entry);
  }

  savePkg(sessionId, pkgId, pkg);
  return enrichPkgPaths(sessionId, pkg);
});

// ── Delete a variant ──
ipcMain.handle('pkg-delete-variant', async (_, { sessionId, pkgId, variantId }) => {
  validateSessionId(sessionId); validatePkgId(pkgId);
  const pkg = loadPkg(sessionId, pkgId);
  if (!pkg) throw new Error('Package not found');
  const dir = getPkgDir(sessionId, pkgId);
  const variant = pkg.variants.find(v => v.id === variantId);
  if (variant) {
    // Delete variant files
    try { fs.unlinkSync(path.join(dir, variant.filename)); } catch {}
    try { fs.unlinkSync(path.join(dir, variant.thumbFile)); } catch {}
    for (const v of (variant.videos || [])) { try { fs.unlinkSync(path.join(dir, v.filename)); } catch {} }
    pkg.variants = pkg.variants.filter(v => v.id !== variantId);
  }
  savePkg(sessionId, pkgId, pkg);
  return enrichPkgPaths(sessionId, pkg);
});

// ── Delete a video from a node ──
ipcMain.handle('pkg-delete-video', async (_, { sessionId, pkgId, nodeId, videoFilename }) => {
  validateSessionId(sessionId); validatePkgId(pkgId);
  const pkg = loadPkg(sessionId, pkgId);
  if (!pkg) throw new Error('Package not found');
  const dir = getPkgDir(sessionId, pkgId);
  const node = (!nodeId || nodeId === 'root') ? pkg.root : pkg.variants.find(v => v.id === nodeId);
  if (node) {
    try { fs.unlinkSync(path.join(dir, videoFilename)); } catch {}
    node.videos = (node.videos || []).filter(v => v.filename !== videoFilename);
  }
  savePkg(sessionId, pkgId, pkg);
  return enrichPkgPaths(sessionId, pkg);
});

// ── Promote first variant to root (merge metadata) ──
ipcMain.handle('pkg-promote-variant', async (_, { sessionId, pkgId }) => {
  validateSessionId(sessionId); validatePkgId(pkgId);
  const pkg = loadPkg(sessionId, pkgId);
  if (!pkg) throw new Error('Package not found');
  if (!pkg.variants || pkg.variants.length === 0) throw new Error('No variants to promote');
  const dir = getPkgDir(sessionId, pkgId);
  const oldRoot = pkg.root;
  const promoted = pkg.variants[0];

  // Merge metadata: old root as base, variant overrides
  const mergedMeta = { ...(oldRoot.metadata || {}), ...(promoted.metadata || promoted.settings || {}) };

  // Delete old root files
  try { fs.unlinkSync(path.join(dir, oldRoot.filename)); } catch {}
  try { if (oldRoot.thumbFile) fs.unlinkSync(path.join(dir, oldRoot.thumbFile)); } catch {}
  for (const v of (oldRoot.videos || [])) { try { fs.unlinkSync(path.join(dir, v.filename)); } catch {} }

  // Promote: variant becomes new root
  pkg.root = {
    ...promoted,
    metadata: mergedMeta,
    id: 'root',
  };
  // Remove promoted variant from list
  pkg.variants = pkg.variants.slice(1);

  savePkg(sessionId, pkgId, pkg);
  return enrichPkgPaths(sessionId, pkg);
});

// ── Delete entire package ──
ipcMain.handle('pkg-delete', async (_, { sessionId, pkgId }) => {
  validateSessionId(sessionId); validatePkgId(pkgId);
  const dir = getPkgDir(sessionId, pkgId);
  if (!isInsideDir(dir, getSessionsDir())) return false;
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  return true;
});

// ── Load all packages for a session ──
ipcMain.handle('pkg-list', async (_, sessionId) => {
  validateSessionId(sessionId);
  const sessionDir = path.join(getSessionsDir(), sessionId);
  if (!fs.existsSync(sessionDir)) return [];
  const pkgs = [];
  for (const entry of fs.readdirSync(sessionDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('pkg_')) continue;
    const pkg = loadPkg(sessionId, entry.name);
    if (pkg) pkgs.push(enrichPkgPaths(sessionId, pkg));
  }
  pkgs.sort((a, b) => (b.created || 0) - (a.created || 0));
  return pkgs;
});

// ── Migrate legacy images to packages ──
ipcMain.handle('pkg-migrate-legacy', async (_, sessionId) => {
  validateSessionId(sessionId);
  const sessionDir = path.join(getSessionsDir(), sessionId);
  if (!fs.existsSync(sessionDir)) return [];
  // Find images not inside any pkg_ folder
  const files = fs.readdirSync(sessionDir).filter(f => /\.(png|jpg|jpeg|webp)$/i.test(f));
  const created = [];
  for (const imgFile of files) {
    const imgPath = path.join(sessionDir, imgFile);
    const metaPath = path.join(sessionDir, `${imgFile}.json`);
    let metadata = {};
    try { if (fs.existsSync(metaPath)) metadata = JSON.parse(fs.readFileSync(metaPath, 'utf-8')); } catch {}

    const pkgId = `pkg_${Date.now()}_${Math.random().toString(36).substring(2, 5)}`;
    const dir = getPkgDir(sessionId, pkgId);
    fs.mkdirSync(dir, { recursive: true });

    const rootFile = 'root.png';
    const thumbFile = 'root_thumb.jpg';
    fs.copyFileSync(imgPath, path.join(dir, rootFile));
    generateThumb(path.join(dir, rootFile), path.join(dir, thumbFile));

    // Migrate videos if any
    const videos = [];
    if (metadata.videos?.length) {
      for (const v of metadata.videos) {
        if (v.path && fs.existsSync(v.path)) {
          const vName = `video_${Date.now()}_${Math.random().toString(36).substring(2, 5)}.mp4`;
          try {
            fs.copyFileSync(v.path, path.join(dir, vName));
            videos.push({ filename: vName, created: v.created || Date.now(), vlmPrompt: v.vlmPrompt || '', source: v.mode || 'studio' });
          } catch {}
        }
      }
    }

    const pkg = {
      id: pkgId,
      created: metadata.created || fs.statSync(imgPath).mtimeMs,
      root: { filename: rootFile, thumbFile, metadata: { ...metadata, videos: undefined, animatedVideo: undefined, animatedVideoPath: undefined }, videos },
      variants: [],
    };
    savePkg(sessionId, pkgId, pkg);
    created.push(enrichPkgPaths(sessionId, pkg));

    // Remove old files after migration
    try { fs.unlinkSync(imgPath); } catch {}
    try { fs.unlinkSync(metaPath); } catch {}
  }
  return created;
});

/**
 * Update an image's metadata sidecar (e.g. to link an animated video).
 */
ipcMain.handle('session-update-image-meta', async (_, sessionId, imageFilename, updates) => {
  const metaPath = path.join(getSessionsDir(), sessionId, `${imageFilename}.json`);
  let meta = {};
  try { if (fs.existsSync(metaPath)) meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8')); } catch {}
  Object.assign(meta, updates);
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
  return meta;
});

// ═══════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════
// GALLERY — IMPORTS
// ═══════════════════════════════════════════════════════════════════

const MEDIA_EXTS = ['.png','.jpg','.jpeg','.webp','.bmp','.gif','.mp4','.webm','.mov','.avi'];

function scanMediaRecursive(dir, basePath = '') {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const fp = path.join(dir, e.name);
      const rp = basePath ? `${basePath}/${e.name}` : e.name;
      if (e.isDirectory()) results.push(...scanMediaRecursive(fp, rp));
      else if (MEDIA_EXTS.includes(path.extname(e.name).toLowerCase())) {
        const isVideo = /\.(mp4|webm|mov|avi|gif)$/i.test(e.name);
        results.push({ filename: e.name, path: fp, relativePath: rp, isVideo, preview: `file:///${fp.replace(/\\/g, '/')}`, size: fs.statSync(fp).size });
      }
    }
  } catch {}
  return results;
}

function getImportCategories(importDir) {
  const categories = [];
  if (!fs.existsSync(importDir)) return categories;
  for (const e of fs.readdirSync(importDir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const catPath = path.join(importDir, e.name);
    const subcats = [];
    let directCount = 0;
    for (const sub of fs.readdirSync(catPath, { withFileTypes: true })) {
      if (sub.isDirectory()) {
        const subPath = path.join(catPath, sub.name);
        const files = scanMediaRecursive(subPath);
        subcats.push({ name: sub.name, path: subPath, count: files.length });
      } else if (MEDIA_EXTS.includes(path.extname(sub.name).toLowerCase())) directCount++;
    }
    categories.push({ name: e.name, path: catPath, subcategories: subcats, directCount });
  }
  return categories;
}

// Import a folder — moves it into app's imports/ directory
ipcMain.handle('gallery-import-folder', async () => {
  const result = await dialog.showOpenDialog({ properties: ['openDirectory'] });
  if (result.canceled || !result.filePaths[0]) return null;
  const srcDir = result.filePaths[0];
  const folderName = path.basename(srcDir);
  let destName = sanitizeName(folderName);
  const importsDir = getImportsDir();
  let counter = 1;
  while (fs.existsSync(path.join(importsDir, destName))) { destName = `${sanitizeName(folderName)}_${counter++}`; }
  const destDir = path.join(importsDir, destName);

  try {
    const copyRecursive = (src, dest) => {
      fs.mkdirSync(dest, { recursive: true });
      for (const e of fs.readdirSync(src, { withFileTypes: true })) {
        const s = path.join(src, e.name), d = path.join(dest, e.name);
        if (e.isDirectory()) copyRecursive(s, d);
        else fs.copyFileSync(s, d);
      }
    };
    copyRecursive(srcDir, destDir);
    const files = scanMediaRecursive(destDir);
    return { name: destName, path: destDir, fileCount: files.length };
  } catch (err) {
    // Clean up partial copy on failure
    try { if (fs.existsSync(destDir)) fs.rmSync(destDir, { recursive: true, force: true }); } catch {}
    throw new Error(`Import failed: ${err.message}`);
  }
});

// List all import categories
ipcMain.handle('gallery-list-imports', async () => {
  return getImportCategories(getImportsDir());
});

// List files in a category or subcategory
ipcMain.handle('gallery-list-files', async (_, categoryPath) => {
  if (!categoryPath || !fs.existsSync(categoryPath)) return [];
  if (!isInsideDir(categoryPath, getImportsDir())) return [];
  const results = [];
  for (const e of fs.readdirSync(categoryPath, { withFileTypes: true })) {
    if (e.isDirectory()) continue;
    const fp = path.join(categoryPath, e.name);
    if (MEDIA_EXTS.includes(path.extname(e.name).toLowerCase())) {
      const isVideo = /\.(mp4|webm|mov|avi|gif)$/i.test(e.name);
      results.push({ filename: e.name, path: fp, isVideo, preview: `file:///${fp.replace(/\\/g, '/')}`, size: fs.statSync(fp).size });
    }
  }
  return results;
});

// Delete an import category
ipcMain.handle('gallery-delete-import', async (_, categoryPath) => {
  if (!categoryPath || !categoryPath.startsWith(getImportsDir())) return false;
  if (fs.existsSync(categoryPath)) fs.rmSync(categoryPath, { recursive: true, force: true });
  return true;
});

// Move media file between categories
ipcMain.handle('gallery-move-media', async (_, { sourcePath, destCategoryPath }) => {
  if (!sourcePath || !destCategoryPath) return false;
  if (!isInsideDir(sourcePath, getImportsDir()) || !isInsideDir(destCategoryPath, getImportsDir())) return false;
  const dest = path.join(destCategoryPath, path.basename(sourcePath));
  if (!fs.existsSync(destCategoryPath)) fs.mkdirSync(destCategoryPath, { recursive: true });
  fs.renameSync(sourcePath, dest);
  return { path: dest, preview: `file:///${dest.replace(/\\/g, '/')}` };
});

// Create a new category folder
ipcMain.handle('gallery-create-category', async (_, name) => {
  const safeName = sanitizeName(name);
  const dir = path.join(getImportsDir(), safeName);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return { name: safeName, path: dir, subcategories: [], directCount: 0 };
});

// List ALL packages across ALL sessions (for Generated tab)
ipcMain.handle('gallery-list-all-packages', async () => {
  const sessionsDir = getSessionsDir();
  if (!fs.existsSync(sessionsDir)) return [];
  const allPkgs = [];
  for (const sessEntry of fs.readdirSync(sessionsDir, { withFileTypes: true })) {
    if (!sessEntry.isDirectory()) continue;
    const sessionId = sessEntry.name;
    const sessionDir = path.join(sessionsDir, sessionId);
    // Read session name
    let sessionName = sessionId;
    const metaPath = path.join(sessionDir, 'session.json');
    try { if (fs.existsSync(metaPath)) sessionName = JSON.parse(fs.readFileSync(metaPath, 'utf-8')).name || sessionId; } catch {}
    for (const pkgEntry of fs.readdirSync(sessionDir, { withFileTypes: true })) {
      if (!pkgEntry.isDirectory() || !pkgEntry.name.startsWith('pkg_')) continue;
      const pkg = loadPkg(sessionId, pkgEntry.name);
      if (pkg) {
        const enriched = enrichPkgPaths(sessionId, pkg);
        enriched.sessionId = sessionId;
        enriched.sessionName = sessionName;
        allPkgs.push(enriched);
      }
    }
  }
  allPkgs.sort((a, b) => (b.created || 0) - (a.created || 0));
  return allPkgs;
});

// EXISTING HANDLERS
// ═══════════════════════════════════════════════════════════

ipcMain.handle('scan-loras-path', async (_, dirPath) => dirPath ? scanDir(dirPath, ['.safetensors', '.ckpt', '.pt']) : []);
/** Get ComfyUI root for input/ folder access (set separately from models path) */
function getComfyRoot() {
  return comfyuiPath || '';
}

ipcMain.handle('scan-loras', async () => scanDir(path.join(modelsPath, 'loras'), ['.safetensors', '.ckpt', '.pt']));
ipcMain.handle('scan-checkpoints', async () => scanDir(path.join(modelsPath, 'checkpoints'), ['.safetensors', '.ckpt', '.pt']));
ipcMain.handle('scan-videos', async () => scanDir(path.join(getComfyRoot(), 'input'), ['.mp4', '.webm', '.avi', '.mov', '.gif']));
ipcMain.handle('scan-images', async () => scanDir(path.join(getComfyRoot(), 'input'), ['.png', '.jpg', '.jpeg', '.webp', '.bmp']));
ipcMain.handle('scan-upscale-models', async () => scanDir(path.join(modelsPath, 'upscale_models'), ['.pth', '.safetensors', '.pt', '.bin', '.onnx']));
ipcMain.handle('scan-latent-upscale-models', async () => scanDir(path.join(modelsPath, 'latent_upscale_models'), ['.pth', '.safetensors', '.pt', '.bin']));
ipcMain.handle('scan-models-folder', async (_, folderPath) => {
  if (!folderPath) return [];
  return scanDir(folderPath, ['.pth', '.safetensors', '.pt', '.bin', '.onnx', '.ckpt']);
});
ipcMain.handle('get-comfyui-path', () => comfyuiPath);
ipcMain.handle('set-comfyui-path', (_, p) => {
  comfyuiPath = p;
  const settings = loadSettings();
  settings.comfyuiPath = p;
  saveSettings(settings);
  return comfyuiPath;
});
ipcMain.handle('get-models-path', () => modelsPath);
ipcMain.handle('list-subfolders', async (_, dirPath) => {
  if (!dirPath || !fs.existsSync(dirPath)) return [];
  try {
    return fs.readdirSync(dirPath, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => e.name)
      .sort();
  } catch { return []; }
});
ipcMain.handle('set-models-path', (_, p) => {
  modelsPath = p;
  const settings = loadSettings();
  settings.modelsPath = p;
  saveSettings(settings);
  return modelsPath;
});
ipcMain.handle('select-folder', async () => { const r = await dialog.showOpenDialog({ properties: ['openDirectory'] }); return r.canceled ? null : r.filePaths[0]; });
ipcMain.handle('select-file', async (_, filters) => { const r = await dialog.showOpenDialog({ properties: ['openFile'], filters: filters || [{ name: 'All', extensions: ['*'] }] }); return r.canceled ? null : r.filePaths[0]; });
ipcMain.handle('read-file', async (_, p) => { try { return fs.readFileSync(p, 'utf-8'); } catch { return null; } });
ipcMain.handle('get-output-dir', () => getOutputDir());

// ── Director Project System ──
// IPC handlers live in electron/ipc/director.js. Register them here, passing
// getter functions for mutable main-process state (comfyuiPath changes when
// the user picks a different ComfyUI folder, so we pass a getter not a value).
require('./ipc/director')({
  ipcMain,
  getOutputDir,
  getComfyuiPath: () => comfyuiPath,
  getFFmpegPath,
});

// ── Voice Server (STT + TTS) ──
// Registers voice-setup/start/stop/running handlers and returns a killer that
// the window-close / will-quit handlers call so the Python subprocess can't
// outlive the app.
const voiceIpc = require('./ipc/voice')({
  ipcMain,
  getAppDir,
  sendLog,
});
// Get session folder path (for Studio animate — SaveVideoChunk writes here)
ipcMain.handle('get-session-path', async (_, sessionId) => {
  if (!sessionId) return '';
  const outputDir = getOutputDir();
  const sessDir = path.join(outputDir, 'sessions', sessionId);
  if (!fs.existsSync(sessDir)) fs.mkdirSync(sessDir, { recursive: true });
  return sessDir;
});

// Find latest video in a folder matching a prefix
ipcMain.handle('find-latest-video', async (_, folderPath, prefix) => {
  try {
    if (!folderPath || !fs.existsSync(folderPath)) return { ok: false, error: 'Folder not found' };
    const files = fs.readdirSync(folderPath)
      .filter(f => f.endsWith('.mp4') && (!prefix || f.includes(prefix)))
      .map(f => ({ name: f, path: path.join(folderPath, f), time: fs.statSync(path.join(folderPath, f)).mtimeMs }))
      .sort((a, b) => b.time - a.time);
    if (files.length === 0) return { ok: false, error: `No .mp4 matching "${prefix}" in ${folderPath}` };
    return { ok: true, path: files[0].path, name: files[0].name, size: fs.statSync(files[0].path).size };
  } catch (e) { return { ok: false, error: e.message }; }
});

// Copy a local file to ComfyUI input/ for serving
ipcMain.handle('copy-file-to-comfy-input', async (_, srcPath, targetName) => {
  try {
    const comfyInput = path.join(comfyuiPath, 'input');
    if (!fs.existsSync(comfyInput)) fs.mkdirSync(comfyInput, { recursive: true });
    const dstPath = path.join(comfyInput, targetName);
    fs.copyFileSync(srcPath, dstPath);
    return { ok: true, name: targetName, path: dstPath };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('load-settings', () => loadSettings());
ipcMain.handle('save-settings', (_, s) => saveSettings(s));
ipcMain.handle('get-default-lora-path', () => path.join(modelsPath || getComfyRoot(), 'loras'));

ipcMain.handle('save-video-locally', async (_, { url, genIndex }) => {
  const outputDir = getOutputDir();
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filename = `SVIPRO_${String(genIndex).padStart(4, '0')}_${ts}.mp4`;
  const localPath = path.join(outputDir, filename);
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      if (res.statusCode !== 200) return reject(new Error(`Download failed: ${res.statusCode}`));
      const stream = fs.createWriteStream(localPath);
      res.pipe(stream);
      stream.on('finish', () => { stream.close(); resolve({ localPath, filename }); });
      stream.on('error', reject);
    }).on('error', reject);
  });
});

ipcMain.handle('copy-to-comfyui-input', async (_, localPath) => {
  const root = getComfyRoot();
  if (!root) throw new Error('ComfyUI Root Folder not set. Go to Settings → ComfyUI → ComfyUI Root Folder.');
  const inputDir = path.join(root, 'input');
  if (!fs.existsSync(inputDir)) fs.mkdirSync(inputDir, { recursive: true });
  const dest = path.join(inputDir, path.basename(localPath));
  fs.copyFileSync(localPath, dest);
  return path.basename(localPath);
});

function scanDir(dir, exts) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  function walk(cur, prefix = '') {
    try {
      for (const e of fs.readdirSync(cur, { withFileTypes: true })) {
        const fp = path.join(cur, e.name);
        const rp = prefix ? `${prefix}/${e.name}` : e.name;
        if (e.isDirectory()) walk(fp, rp);
        else if (exts.includes(path.extname(e.name).toLowerCase()))
          results.push({ name: e.name, path: rp, fullPath: fp, size: fs.statSync(fp).size });
      }
    } catch {}
  }
  walk(dir);
  results.sort((a, b) => a.name.localeCompare(b.name));
  return results;
}

// ── Window Controls ──
ipcMain.handle('win-minimize', () => mainWindow?.minimize());
ipcMain.handle('win-maximize', () => {
  if (mainWindow?.isMaximized()) mainWindow.unmaximize();
  else mainWindow?.maximize();
  return mainWindow?.isMaximized();
});
ipcMain.handle('win-close', () => mainWindow?.close());
ipcMain.handle('win-is-maximized', () => mainWindow?.isMaximized());

// ── Clipboard (native) ──
// navigator.clipboard.writeText is flaky in Electron renderers (silently
// rejects under non-secure origins / certain webPreferences). Route through
// the main-process clipboard module so "Copy" buttons actually work.
ipcMain.handle('clipboard-write', (_, text) => {
  try { clipboard.writeText(String(text ?? '')); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('clipboard-read', () => {
  try { return { ok: true, text: clipboard.readText() }; }
  catch (e) { return { ok: false, error: e.message }; }
});

/**
 * Save file to user-chosen location via OS dialog.
 */
// ── Save counter for numbered output filenames ──
function getNextSaveNumber() {
  const settings = loadSettings();
  const num = (settings.saveCounter || 0) + 1;
  saveSettings({ ...settings, saveCounter: num });
  return String(num).padStart(4, '0');
}

function numberedName(defaultName) {
  if (!defaultName) return `wan_${getNextSaveNumber()}`;
  const ext = path.extname(defaultName);
  const base = path.basename(defaultName, ext);
  return `${base}_${getNextSaveNumber()}${ext}`;
}

ipcMain.handle('save-file-as', async (_, { sourcePath, defaultName, filters }) => {
  const win = BrowserWindow.getFocusedWindow();
  const result = await dialog.showSaveDialog(win, {
    defaultPath: numberedName(defaultName),
    filters: filters || [{ name: 'All Files', extensions: ['*'] }],
  });
  if (result.canceled || !result.filePath) return null;
  fs.copyFileSync(sourcePath, result.filePath);
  return result.filePath;
});

// Save a ComfyUI image/video to user-chosen location (downloads from ComfyUI first)
ipcMain.handle('save-comfy-file-as', async (_, { comfyFilename, comfySubfolder, comfyType, defaultName, filters }) => {
  const win = BrowserWindow.getFocusedWindow();
  const result = await dialog.showSaveDialog(win, {
    defaultPath: numberedName(defaultName || comfyFilename),
    filters: filters || [{ name: 'All Files', extensions: ['*'] }],
  });
  if (result.canceled || !result.filePath) return null;
  const buffer = await downloadComfyBuffer(comfyFilename, comfySubfolder || '', comfyType || 'temp');
  fs.writeFileSync(result.filePath, buffer);
  return result.filePath;
});

// Auto-detect Python executable
ipcMain.handle('detect-python', async () => {
  const candidates = process.platform === 'win32' ? ['python', 'python3', 'py'] : ['python3', 'python'];
  for (const cmd of candidates) {
    try {
      const ver = execSync(`${cmd} --version`, { timeout: 5000, encoding: 'utf-8' }).trim();
      if (ver.includes('Python 3')) return { path: cmd, version: ver };
    } catch {}
  }
  return null;
});

/**
 * Launch ComfyUI from a user-specified launcher file (.bat, .py, .exe).
 * Runs in a detached background process.
 */
let comfyProcess = null;

ipcMain.handle('comfy-launch', async (_, { launcherPath }) => {
  if (!launcherPath || !fs.existsSync(launcherPath)) {
    return { error: `Launcher not found: ${launcherPath}` };
  }

  // Check if already running
  try {
    const http = require('http');
    const ok = await new Promise((resolve) => {
      http.get('http://127.0.0.1:8188/system_stats', { timeout: 2000 }, (res) => resolve(res.statusCode === 200))
        .on('error', () => resolve(false))
        .on('timeout', () => resolve(false));
    });
    if (ok) return { status: 'already_running' };
  } catch {}

  const ext = path.extname(launcherPath).toLowerCase();
  const dir = path.dirname(launcherPath);

  console.log(`[ComfyUI] Launching: ${launcherPath}`);

  try {
    const spawnOpts = { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], detached: true, windowsHide: true };
    if (ext === '.bat' || ext === '.cmd') {
      comfyProcess = spawn('cmd.exe', ['/c', launcherPath], { ...spawnOpts, shell: false });
    } else if (ext === '.py') {
      comfyProcess = spawn('python', [launcherPath], spawnOpts);
    } else if (ext === '.exe') {
      comfyProcess = spawn(launcherPath, [], spawnOpts);
    } else {
      return { error: `Unsupported launcher type: ${ext}. Use .bat, .py, or .exe` };
    }

    comfyProcess.unref();
    const onComfyData = (data) => {
      const lines = data.toString().split('\n').filter(l => l.trim());
      for (const line of lines) {
        console.log('[ComfyUI]', line);
        sendLog('comfyui', line);
      }
    };
    comfyProcess.stdout?.on('data', onComfyData);
    comfyProcess.stderr?.on('data', onComfyData);
    comfyProcess.on('error', (err) => {
      console.error('[ComfyUI] Launch error:', err);
      sendLog('comfyui', `ERROR: ${err.message}`);
    });

    // Wait for ComfyUI to respond (up to 120s)
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 2000));
      try {
        const ok = await new Promise((resolve) => {
          http.get('http://127.0.0.1:8188/system_stats', { timeout: 2000 }, (res) => resolve(res.statusCode === 200))
            .on('error', () => resolve(false))
            .on('timeout', () => resolve(false));
        });
        if (ok) {
          console.log(`[ComfyUI] Ready after ~${(i + 1) * 2}s`);
          return { status: 'ok', wait: (i + 1) * 2 };
        }
      } catch {}
    }
    return { error: 'ComfyUI did not respond after 120 seconds' };
  } catch (err) {
    return { error: `Failed to launch: ${err.message}` };
  }
});

app.whenReady().then(async () => {
  // Show splash immediately
  createSplash();
  splashStatus('Loading app...');

  // Wait a beat for splash to render
  await new Promise(r => setTimeout(r, 300));

  try {
    // Check if dev server is available (in dev mode)
    if (!app.isPackaged) {
      splashStatus('Waiting for Vite dev server...');
      let viteReady = false;
      for (let i = 0; i < 30; i++) {
        try {
          const res = await new Promise((resolve, reject) => {
            http.get('http://localhost:5173', { timeout: 1000 }, (r) => resolve(r.statusCode))
              .on('error', reject).on('timeout', reject);
          });
          if (res === 200) { viteReady = true; break; }
        } catch {}
        await new Promise(r => setTimeout(r, 500));
      }
      if (!viteReady) {
        splashError('Vite dev server not responding on http://localhost:5173\n\nMake sure npm run dev is running.\nUse START.bat to launch properly.');
        return;
      }
      splashStatus('Dev server ready!');
    }

    splashStatus('Opening main window...');

    // ── Media permissions ──
    // Voice Chat calls navigator.mediaDevices.getUserMedia({audio:true}) from
    // the renderer. Electron blocks this by default; without a handler the
    // Promise can either reject OR (on some Windows builds) crash the renderer,
    // which presents as a blank window. This handler auto-grants the user's
    // own mic — they've already consented by clicking the mic button in our
    // UI, so there's nothing more to ask.
    session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
      if (permission === 'media' || permission === 'mediaKeySystem' || permission === 'audioCapture') {
        return callback(true);
      }
      callback(false);
    });
    session.defaultSession.setPermissionCheckHandler((_webContents, permission) => {
      return permission === 'media' || permission === 'audioCapture';
    });

    // Ensure ffmpeg is available (auto-install if needed)
    await ensureFFmpeg((msg) => splashStatus(msg));

    createWindow();

    // Setup close handlers on main window
    mainWindow.on('close', async (e) => {
      if (vlmProcess) {
        try { spawn('taskkill', ['/pid', String(vlmProcess.pid), '/f', '/t'], { windowsHide: true }); } catch {}
        vlmProcess = null;
      }
      try { voiceIpc.killVoiceProcess(); } catch {}
      if (comfyProcess) {
        const settings = loadSettings();
        const action = settings.comfyCloseAction || 'ask';
        if (action === 'ask') {
          e.preventDefault();
          const { response } = await dialog.showMessageBox(mainWindow, {
            type: 'question',
            buttons: ['Close ComfyUI', 'Keep ComfyUI Running'],
            defaultId: 0, cancelId: 1,
            title: 'Close ComfyUI?',
            message: 'ComfyUI was started by this app.\nDo you want to close it too?',
          });
          if (response === 0) {
            try { spawn('taskkill', ['/pid', String(comfyProcess.pid), '/f', '/t'], { windowsHide: true }); } catch {}
            comfyProcess = null;
          }
          mainWindow.destroy();
          return;
        } else if (action === 'close') {
          try { spawn('taskkill', ['/pid', String(comfyProcess.pid), '/f', '/t'], { windowsHide: true }); } catch {}
          comfyProcess = null;
        }
      }
    });
  } catch (err) {
    splashError(`Startup error:\n\n${err.message}\n\n${err.stack || ''}`);
  }
});

app.on('window-all-closed', () => app.quit());

// Force-exit entire process tree when quitting — ensures CMD window closes
app.on('will-quit', () => {
  if (vlmProcess) { try { spawn('taskkill', ['/pid', String(vlmProcess.pid), '/f', '/t'], { windowsHide: true }); } catch {} }
  try { voiceIpc.killVoiceProcess(); } catch {}
  setTimeout(() => process.exit(0), 300);
});

/**
 * VLM Server subprocess management
 * Auto-creates a local Python venv and installs dependencies on first use.
 */
let vlmProcess = null;

function getVenvDir() { return path.join(getAppDir(), 'vlm_venv'); }
function getVenvPython() {
  const venvDir = getVenvDir();
  return process.platform === 'win32'
    ? path.join(venvDir, 'Scripts', 'python.exe')
    : path.join(venvDir, 'bin', 'python');
}

function findWheelFile() {
  const appDir = getAppDir();
  try {
    const files = fs.readdirSync(appDir);
    return files.find(f => f.match(/llama_cpp_python.*\.whl$/i));
  } catch { return null; }
}

/**
 * Detect CUDA version from nvidia-smi.
 * Returns version string like '12.4' or null.
 */
function detectCudaVersion() {
  try {
    const output = execSync('nvidia-smi', { stdio: 'pipe', timeout: 10000 }).toString();
    const match = output.match(/CUDA Version:\s*(\d+\.\d+)/);
    return match ? match[1] : null;
  } catch { return null; }
}

/**
 * Map CUDA version to the tag used in wheel filenames.
 * CUDA 12.4 → 'cu124', CUDA 13.0 → 'cu130', CUDA 13.2 → 'cu132'
 */
function cudaToTag(cudaVer) {
  if (!cudaVer) return null;
  const [major, minor] = cudaVer.split('.');
  return `cu${major}${minor}`;
}

/**
 * Get Python version from venv.
 * Returns e.g. 'cp312' for Python 3.12
 */
function getPythonTag(venvPy) {
  try {
    const ver = execFileSync(venvPy, ['-c', 'import sys; print(f"cp{sys.version_info.major}{sys.version_info.minor}")'], { stdio: 'pipe', timeout: 5000 }).toString().trim();
    return ver;
  } catch { return 'cp312'; }
}

/**
 * Download a file from URL to destination path.
 */
function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const https = require('https');
    const followRedirect = (url) => {
      https.get(url, { headers: { 'User-Agent': 'WanVideoStudio' } }, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          return followRedirect(res.headers.location);
        }
        if (res.statusCode !== 200) return reject(new Error(`Download failed: HTTP ${res.statusCode}`));
        const file = fs.createWriteStream(destPath);
        res.pipe(file);
        file.on('finish', () => { file.close(); resolve(); });
        file.on('error', reject);
      }).on('error', reject);
    };
    followRedirect(url);
  });
}

/**
 * Query GitHub API for latest release and find matching wheel.
 */
async function findGitHubWheel(cudaTag, pyTag, platform) {
  const https = require('https');
  return new Promise((resolve, reject) => {
    const url = 'https://api.github.com/repos/JamePeng/llama-cpp-python/releases/latest';
    https.get(url, { headers: { 'User-Agent': 'WanVideoStudio', 'Accept': 'application/vnd.github.v3+json' } }, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          const release = JSON.parse(data);
          const assets = release.assets || [];
          console.log(`[VLM] GitHub release: ${release.tag_name}, ${assets.length} assets`);
          console.log(`[VLM] Looking for: cuda=${cudaTag}, python=${pyTag}, platform=${platform}`);

          // Try exact CUDA match first, then try nearby versions (downward preferred)
          const cudaVersions = [cudaTag];
          const num = parseInt(cudaTag.replace('cu', ''));
          if (num > 0) {
            // Try: exact, -1, -2, -3, -4, -5, +1 (covers full minor range)
            for (let i = 1; i <= 5; i++) cudaVersions.push(`cu${num - i}`);
            cudaVersions.push(`cu${num + 1}`);
          }

          for (const cuda of cudaVersions) {
            const match = assets.find(a => {
              const name = a.name.toLowerCase();
              return name.includes('llama_cpp_python') &&
                     name.includes(cuda) &&
                     name.includes(pyTag) &&
                     name.includes(platform) &&
                     name.endsWith('.whl');
            });
            if (match) {
              console.log(`[VLM] Found wheel: ${match.name} (matched ${cuda})`);
              resolve({ name: match.name, url: match.browser_download_url, size: match.size });
              return;
            }
          }

          // Try basic/default variant
          for (const cuda of cudaVersions) {
            const match = assets.find(a => {
              const name = a.name.toLowerCase();
              return name.includes('llama_cpp_python') &&
                     name.includes(cuda) &&
                     name.includes(pyTag) &&
                     name.endsWith('.whl') &&
                     (name.includes('win') || name.includes(platform));
            });
            if (match) {
              console.log(`[VLM] Found wheel (relaxed match): ${match.name}`);
              resolve({ name: match.name, url: match.browser_download_url, size: match.size });
              return;
            }
          }

          // List available for debugging
          const available = assets.filter(a => a.name.endsWith('.whl')).map(a => a.name);
          console.log('[VLM] Available wheels:', available.join(', '));
          reject(new Error(`No matching wheel found for ${cudaTag}/${pyTag}/${platform}. Available: ${available.length} wheels.`));
        } catch (e) { reject(new Error(`Failed to parse GitHub release: ${e.message}`)); }
      });
    }).on('error', reject);
  });
}

ipcMain.handle('vlm-setup', async (_, { pythonPath, onProgress }) => {
  const venvDir = getVenvDir();
  const venvPy = getVenvPython();
  const py = pythonPath || 'python';

  try {
    // Step 1: Create venv if it doesn't exist
    if (!fs.existsSync(venvPy)) {
      console.log('[VLM] Creating Python venv...');
      execFileSync(py, ['-m', 'venv', venvDir], { stdio: 'pipe', timeout: 60000 });
      console.log('[VLM] Upgrading pip...');
      execFileSync(venvPy, ['-m', 'pip', 'install', '--upgrade', 'pip', '--quiet'], { stdio: 'pipe', timeout: 60000 });
      console.log('[VLM] Venv created at:', venvDir);
    }

    // Step 2: Ensure all dependencies are installed
    const requiredPkgs = ['flask', 'numpy', 'typing_extensions', 'diskcache', 'jinja2', 'PIL'];
    let missingDeps = false;
    for (const pkg of requiredPkgs) {
      try { execFileSync(venvPy, ['-c', `import ${pkg}`], { stdio: 'pipe', timeout: 5000 }); }
      catch { missingDeps = true; break; }
    }
    if (missingDeps) {
      console.log('[VLM] Installing dependencies...');
      execFileSync(venvPy, ['-m', 'pip', 'install', 'flask', 'numpy', 'diskcache', 'jinja2', 'typing-extensions', 'Pillow', '--quiet'], { stdio: 'pipe', timeout: 120000 });
      console.log('[VLM] Dependencies installed');
    }

    // Step 3: Install or upgrade llama-cpp-python
    let currentVersion = null;
    try {
      currentVersion = execFileSync(venvPy, ['-c', 'import llama_cpp; print(llama_cpp.__version__)'], { stdio: 'pipe', timeout: 10000 }).toString().trim();
      console.log(`[VLM] Current llama-cpp-python: ${currentVersion}`);
    } catch {
      console.log('[VLM] llama-cpp-python not installed');
    }

    // Check for bundled wheel first, then GitHub
    let wheel = null;
    let wheelPath = null;

    // Try GitHub first (to get latest version)
    try {
      console.log('[VLM] Querying GitHub for latest wheel...');
      const cudaVer = detectCudaVersion();
      const cudaTag = cudaToTag(cudaVer);
      const pyTag = getPythonTag(venvPy);
      const platform = process.platform === 'win32' ? 'win_amd64' : 'linux_x86_64';
      console.log(`[VLM] System: CUDA ${cudaVer} (${cudaTag}), Python ${pyTag}, ${platform}`);

      if (!cudaTag) {
        return { error: 'Could not detect CUDA version. Please install NVIDIA drivers and ensure nvidia-smi works.' };
      }

      const ghWheel = await findGitHubWheel(cudaTag, pyTag, platform);
      const ghVersion = ghWheel.name.match(/llama_cpp_python-([^+]+)/)?.[1] || '';

      if (currentVersion && ghVersion && currentVersion === ghVersion) {
        console.log(`[VLM] Already on latest version: ${currentVersion}`);
        return { status: 'ok', python: venvPy, message: `Already on latest (${currentVersion})` };
      }

      wheelPath = path.join(getAppDir(), ghWheel.name);
      if (!fs.existsSync(wheelPath)) {
        console.log(`[VLM] Downloading ${ghWheel.name} (${Math.round(ghWheel.size / 1024 / 1024)}MB)...`);
        await downloadFile(ghWheel.url, wheelPath);
        console.log('[VLM] Download complete');
      }
      wheel = ghWheel.name;
    } catch (ghErr) {
      console.log(`[VLM] GitHub check failed: ${ghErr.message}`);
      // Fall back to bundled wheel if GitHub fails (no internet, etc.)
      wheel = findWheelFile();
      if (wheel) {
        wheelPath = path.join(getAppDir(), wheel);
        console.log('[VLM] Falling back to bundled wheel:', wheel);
      } else if (currentVersion) {
        console.log('[VLM] No update available offline, keeping current version');
        return { status: 'ok', python: venvPy, message: `Offline — kept ${currentVersion}` };
      } else {
        return { error: 'No internet and no bundled wheel. Cannot install llama-cpp-python.' };
      }
    }

    // Install the wheel
    console.log(`[VLM] Installing llama-cpp-python${currentVersion ? ` (upgrading from ${currentVersion})` : ''}...`);
    const cleanName = wheel.replace(/\+[^-]*/, '');
    const tempPath = path.join(getAppDir(), cleanName);
    let usePath = wheelPath;
    if (cleanName !== wheel) {
      fs.copyFileSync(wheelPath, tempPath);
      usePath = tempPath;
    }
    try {
      execFileSync(venvPy, ['-m', 'pip', 'install', usePath, '--force-reinstall', '--no-deps', '--quiet'], { stdio: 'pipe', timeout: 300000 });
    } finally {
      if (cleanName !== wheel && fs.existsSync(tempPath)) {
        try { fs.unlinkSync(tempPath); } catch {}
      }
    }

    // Verify
    try {
      const newVer = execFileSync(venvPy, ['-c', 'import llama_cpp; print(llama_cpp.__version__)'], { stdio: 'pipe', timeout: 10000 }).toString().trim();
      console.log(`[VLM] llama-cpp-python installed: ${newVer}`);
    } catch {}

    return { status: 'ok', python: venvPy };
  } catch (err) {
    console.error('[VLM] Setup error:', err);
    return { error: `VLM setup failed: ${err.message}` };
  }
});

ipcMain.handle('vlm-start', async (_, { pythonPath }) => {
  if (vlmProcess) return { status: 'already_running' };
  const serverScript = path.join(getAppDir(), 'vlm_server.py');
  if (!fs.existsSync(serverScript)) return { error: 'vlm_server.py not found' };

  // Use venv python if available, otherwise fall back to provided path
  const venvPy = getVenvPython();
  const py = fs.existsSync(venvPy) ? venvPy : (pythonPath || 'python');
  console.log('[VLM] Starting server with:', py);

  return new Promise((resolve) => {
    vlmProcess = spawn(py, [serverScript, '--port', '5123'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
      windowsHide: true,
    });
    let started = false;
    const onData = (data) => {
      const lines = data.toString().split('\n').filter(l => l.trim());
      for (const line of lines) {
        console.log('[VLM]', line);
        sendLog('vlm', line);
      }
      if (!started && data.toString().includes('Running on')) {
        started = true;
        resolve({ status: 'ok' });
      }
    };
    vlmProcess.stdout.on('data', onData);
    vlmProcess.stderr.on('data', onData);
    vlmProcess.on('error', (err) => {
      vlmProcess = null;
      if (!started) resolve({ error: err.message });
    });
    vlmProcess.on('exit', (code) => {
      console.log(`[VLM] Server exited with code ${code}`);
      vlmProcess = null;
    });
    setTimeout(() => { if (!started) resolve({ error: 'VLM server start timeout (30s)' }); }, 30000);
  });
});

ipcMain.handle('vlm-stop', async () => {
  if (vlmProcess) { vlmProcess.kill(); vlmProcess = null; }
  return { status: 'ok' };
});

ipcMain.handle('vlm-running', () => ({ running: vlmProcess !== null }));

ipcMain.handle('vlm-system-info', () => {
  const cudaVer = detectCudaVersion();
  let gpuName = null;
  try {
    const out = execSync('nvidia-smi --query-gpu=name --format=csv,noheader,nounits', { stdio: 'pipe', timeout: 5000 }).toString().trim();
    gpuName = out.split('\n')[0];
  } catch {}
  let pyVer = null;
  try { pyVer = execSync('python --version', { stdio: 'pipe', timeout: 5000 }).toString().trim(); } catch {}
  const venvExists = fs.existsSync(getVenvPython());
  let llamaInstalled = false;
  if (venvExists) {
    try { execFileSync(getVenvPython(), ['-c', 'import llama_cpp'], { stdio: 'pipe', timeout: 5000 }); llamaInstalled = true; } catch {}
  }
  return { cudaVersion: cudaVer, cudaTag: cudaToTag(cudaVer), gpuName, pythonVersion: pyVer, venvReady: venvExists, llamaInstalled };
});

ipcMain.handle('vlm-ram-check', () => {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedPercent = Math.round(((totalMem - freeMem) / totalMem) * 100);
  return {
    totalGB: Math.round(totalMem / 1024 / 1024 / 1024),
    freeGB: Math.round(freeMem / 1024 / 1024 / 1024 * 10) / 10,
    usedPercent,
    critical: usedPercent >= 90,
  };
});

// ═══════════════════════════════════════════════════════════
// COMFYUI INSTALLATION & MANAGEMENT
// ═══════════════════════════════════════════════════════════

ipcMain.handle('verify-comfyui', async (_, dirPath) => {
  // Check if this looks like a ComfyUI install
  if (fs.existsSync(path.join(dirPath, 'main.py'))) return true;
  if (fs.existsSync(path.join(dirPath, 'ComfyUI', 'main.py'))) return true;
  // Check for ComfyUI-Easy-Install structure
  if (fs.existsSync(path.join(dirPath, 'ComfyUI'))) return true;
  return false;
});

ipcMain.handle('install-comfyui', async (event) => {
  const https = require('https');
  const { createWriteStream } = require('fs');

  const installDir = path.join(getAppDir(), '..');
  const zipPath = path.join(installDir, 'ComfyUI-Easy-Install.zip');
  const extractDir = path.join(installDir, 'ComfyUI-Easy-Install');

  // If already extracted, just return the path
  if (fs.existsSync(path.join(extractDir, 'ComfyUI', 'main.py'))) {
    const comfyDir = path.join(extractDir, 'ComfyUI');
    comfyuiPath = comfyDir;
    const settings = loadSettings();
    settings.comfyuiPath = comfyDir;
    saveSettings(settings);
    return { path: comfyDir };
  }

  try {
    // Step 1: Download zip
    console.log('[ComfyUI] Downloading ComfyUI-Easy-Install...');
    const downloadUrl = 'https://github.com/Tavris1/ComfyUI-Easy-Install/releases/latest/download/ComfyUI-Easy-Install.zip';
    await new Promise((resolve, reject) => {
      const followRedirect = (url) => {
        https.get(url, { headers: { 'User-Agent': 'WanVideoStudio' } }, (res) => {
          if (res.statusCode === 301 || res.statusCode === 302) {
            return followRedirect(res.headers.location);
          }
          if (res.statusCode !== 200) return reject(new Error(`Download failed: HTTP ${res.statusCode}`));
          const total = parseInt(res.headers['content-length'] || '0');
          let downloaded = 0;
          const file = createWriteStream(zipPath);
          res.on('data', (chunk) => {
            downloaded += chunk.length;
            file.write(chunk);
            if (total > 0) {
              const pct = Math.round(downloaded / total * 100);
              const mb = Math.round(downloaded / 1024 / 1024);
              const totalMb = Math.round(total / 1024 / 1024);
              // Send progress to renderer via BrowserWindow
              const win = BrowserWindow.getAllWindows()[0];
              if (win) win.webContents.send('comfyui-install-progress', `Downloading... ${mb}MB / ${totalMb}MB (${pct}%)`);
            }
          });
          res.on('end', () => { file.end(); resolve(); });
          res.on('error', reject);
          file.on('error', reject);
        }).on('error', reject);
      };
      followRedirect(downloadUrl);
    });
    console.log('[ComfyUI] Download complete');

    // Step 2: Extract zip
    const win = BrowserWindow.getAllWindows()[0];
    if (win) win.webContents.send('comfyui-install-progress', 'Extracting... (this may take a few minutes)');

    // Use PowerShell to extract (available on all Windows 10+)
    console.log('[ComfyUI] Extracting...');
    execSync(`powershell -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${installDir}' -Force"`, {
      stdio: 'pipe', timeout: 600000, // 10 min timeout
    });
    console.log('[ComfyUI] Extraction complete');

    // Clean up zip
    try { fs.unlinkSync(zipPath); } catch {}

    // Find ComfyUI path
    let comfyDir = '';
    if (fs.existsSync(path.join(extractDir, 'ComfyUI', 'main.py'))) {
      comfyDir = path.join(extractDir, 'ComfyUI');
    } else if (fs.existsSync(path.join(extractDir, 'main.py'))) {
      comfyDir = extractDir;
    } else {
      return { error: 'Extraction succeeded but could not find ComfyUI main.py' };
    }

    // Save path
    comfyuiPath = comfyDir;
    const settings = loadSettings();
    settings.comfyuiPath = comfyDir;
    saveSettings(settings);

    return { path: comfyDir };
  } catch (err) {
    console.error('[ComfyUI] Install error:', err);
    // Clean up partial download
    try { if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath); } catch {}
    return { error: err.message };
  }
});

ipcMain.handle('comfyui-start', async () => {
  if (comfyProcess) return { status: 'already_running' };
  if (!comfyuiPath || !fs.existsSync(path.join(comfyuiPath, 'main.py'))) {
    return { error: 'ComfyUI path not configured or main.py not found' };
  }

  // Look for Python in the ComfyUI-Easy-Install structure
  const easyInstallDir = path.dirname(comfyuiPath);
  const possiblePythons = [
    path.join(easyInstallDir, 'python', 'python.exe'),
    path.join(easyInstallDir, 'python_embeded', 'python.exe'),
    path.join(easyInstallDir, 'venv', 'Scripts', 'python.exe'),
    'python',
  ];
  let pythonExe = 'python';
  for (const p of possiblePythons) {
    if (p !== 'python' && fs.existsSync(p)) { pythonExe = p; break; }
  }

  console.log(`[ComfyUI] Starting with: ${pythonExe} ${path.join(comfyuiPath, 'main.py')}`);

  return new Promise((resolve) => {
    comfyProcess = spawn(pythonExe, ['main.py', '--listen', '127.0.0.1', '--port', '8188'], {
      cwd: comfyuiPath,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });
    let started = false;
    const onData = (data) => {
      const msg = data.toString();
      console.log('[ComfyUI]', msg.trim());
      if (!started && (msg.includes('To see the GUI go to') || msg.includes('Starting server'))) {
        started = true;
        resolve({ status: 'ok' });
      }
    };
    comfyProcess.stdout.on('data', onData);
    comfyProcess.stderr.on('data', onData);
    comfyProcess.on('error', (err) => {
      comfyProcess = null;
      if (!started) resolve({ error: err.message });
    });
    comfyProcess.on('exit', (code) => {
      console.log(`[ComfyUI] Exited with code ${code}`);
      comfyProcess = null;
    });
    setTimeout(() => { if (!started) resolve({ status: 'ok' }); }, 60000);
  });
});

ipcMain.handle('comfyui-stop', async () => {
  if (comfyProcess) { comfyProcess.kill(); comfyProcess = null; }
  return { status: 'ok' };
});

ipcMain.handle('comfyui-running', () => ({ running: comfyProcess !== null }));

