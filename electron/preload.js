const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Window controls
  winMinimize: () => ipcRenderer.invoke('win-minimize'),
  winMaximize: () => ipcRenderer.invoke('win-maximize'),
  winClose: () => ipcRenderer.invoke('win-close'),
  winIsMaximized: () => ipcRenderer.invoke('win-is-maximized'),

  // Clipboard — routes through Electron's native clipboard module, which
  // is more reliable than navigator.clipboard in the renderer.
  clipboardWrite: (text) => ipcRenderer.invoke('clipboard-write', text),
  clipboardRead: () => ipcRenderer.invoke('clipboard-read'),

  // Session management
  sessionCreate: (name) => ipcRenderer.invoke('session-create', name),
  sessionGetOrCreate: (tabName) => ipcRenderer.invoke('session-get-or-create', tabName),
  sessionList: () => ipcRenderer.invoke('session-list'),
  sessionLoad: (id) => ipcRenderer.invoke('session-load', id),
  sessionUpdate: (id, updates) => ipcRenderer.invoke('session-update', id, updates),
  sessionDelete: (id) => ipcRenderer.invoke('session-delete', id),
  sessionSaveImage: (id, base64, prefix, metadata) => ipcRenderer.invoke('session-save-image', id, base64, prefix, metadata),
  sessionDeleteImage: (id, filename) => ipcRenderer.invoke('session-delete-image', id, filename),
  sessionGetImagePath: (id, filename) => ipcRenderer.invoke('session-get-image-path', id, filename),
  getLastSessionId: () => ipcRenderer.invoke('get-last-session-id'),
  downloadComfyUIImage: (opts) => ipcRenderer.invoke('download-comfyui-image', opts),
  downloadComfyUIVideo: (opts) => ipcRenderer.invoke('download-comfyui-video', opts),
  saveFileAs: (opts) => ipcRenderer.invoke('save-file-as', opts),
  saveComfyFileAs: (opts) => ipcRenderer.invoke('save-comfy-file-as', opts),
  detectPython: () => ipcRenderer.invoke('detect-python'),
  sessionUpdateImageMeta: (sessionId, filename, updates) => ipcRenderer.invoke('session-update-image-meta', sessionId, filename, updates),

  // Package system
  pkgCreate: (opts) => ipcRenderer.invoke('pkg-create', opts),
  pkgCreateFromUrl: (opts) => ipcRenderer.invoke('pkg-create-from-url', opts),
  pkgAddVariant: (opts) => ipcRenderer.invoke('pkg-add-variant', opts),
  pkgReplaceImage: (opts) => ipcRenderer.invoke('pkg-replace-image', opts),
  pkgAddVideo: (opts) => ipcRenderer.invoke('pkg-add-video', opts),
  pkgDeleteVariant: (opts) => ipcRenderer.invoke('pkg-delete-variant', opts),
  pkgPromoteVariant: (opts) => ipcRenderer.invoke('pkg-promote-variant', opts),
  pkgDeleteVideo: (opts) => ipcRenderer.invoke('pkg-delete-video', opts),
  pkgDelete: (opts) => ipcRenderer.invoke('pkg-delete', opts),
  pkgList: (sessionId) => ipcRenderer.invoke('pkg-list', sessionId),
  pkgMigrateLegacy: (sessionId) => ipcRenderer.invoke('pkg-migrate-legacy', sessionId),

  // Gallery
  galleryImportFolder: () => ipcRenderer.invoke('gallery-import-folder'),
  galleryListImports: () => ipcRenderer.invoke('gallery-list-imports'),
  galleryListFiles: (catPath) => ipcRenderer.invoke('gallery-list-files', catPath),
  galleryDeleteImport: (catPath) => ipcRenderer.invoke('gallery-delete-import', catPath),
  galleryMoveMedia: (opts) => ipcRenderer.invoke('gallery-move-media', opts),
  galleryCreateCategory: (name) => ipcRenderer.invoke('gallery-create-category', name),
  galleryListAllPackages: () => ipcRenderer.invoke('gallery-list-all-packages'),

  // Existing
  scanLoras: () => ipcRenderer.invoke('scan-loras'),
  scanLorasPath: (p) => ipcRenderer.invoke('scan-loras-path', p),
  scanCheckpoints: () => ipcRenderer.invoke('scan-checkpoints'),
  scanVideos: () => ipcRenderer.invoke('scan-videos'),
  scanImages: () => ipcRenderer.invoke('scan-images'),
  scanModelsFolder: (folderPath) => ipcRenderer.invoke('scan-models-folder', folderPath),
  scanUpscaleModels: () => ipcRenderer.invoke('scan-upscale-models'),
  scanLatentUpscaleModels: () => ipcRenderer.invoke('scan-latent-upscale-models'),
  getComfyUIPath: () => ipcRenderer.invoke('get-comfyui-path'),
  setComfyUIPath: (p) => ipcRenderer.invoke('set-comfyui-path', p),
  getModelsPath: () => ipcRenderer.invoke('get-models-path'),
  setModelsPath: (p) => ipcRenderer.invoke('set-models-path', p),
  listSubfolders: (p) => ipcRenderer.invoke('list-subfolders', p),
  selectFile: (filters) => ipcRenderer.invoke('select-file', filters),
  selectFolder: () => ipcRenderer.invoke('select-folder'),
  readFile: (p) => ipcRenderer.invoke('read-file', p),
  getOutputDir: () => ipcRenderer.invoke('get-output-dir'),
  // Director project system
  directorSaveProject: (opts) => ipcRenderer.invoke('director-save-project', opts),
  directorLoadProject: (id) => ipcRenderer.invoke('director-load-project', id),
  directorListProjects: () => ipcRenderer.invoke('director-list-projects'),
  directorGetVideoUrl: (sessionId) => ipcRenderer.invoke('director-get-video-url', sessionId),
  directorSaveImage: (opts) => ipcRenderer.invoke('director-save-image', opts),
  directorPushLatent: (opts) => ipcRenderer.invoke('director-push-latent', opts),
  directorPushVideo: (opts) => ipcRenderer.invoke('director-push-video', opts),
  directorGrabLatent: (opts) => ipcRenderer.invoke('director-grab-latent', opts),
  directorSaveVideo: (opts) => ipcRenderer.invoke('director-save-video', opts),
  directorSaveClip: (opts) => ipcRenderer.invoke('director-save-clip', opts),
  directorConcatClips: (opts) => ipcRenderer.invoke('director-concat-clips', opts),
  getSessionPath: (id) => ipcRenderer.invoke('get-session-path', id),
  findLatestVideo: (folder, prefix) => ipcRenderer.invoke('find-latest-video', folder, prefix),
  copyFileToComfyInput: (src, name) => ipcRenderer.invoke('copy-file-to-comfy-input', src, name),
  directorGetProjectPath: (id) => ipcRenderer.invoke('director-get-project-path', id),
  loadSettings: () => ipcRenderer.invoke('load-settings'),
  saveSettings: (s) => ipcRenderer.invoke('save-settings', s),
  getDefaultLoraPath: () => ipcRenderer.invoke('get-default-lora-path'),
  saveVideoLocally: (opts) => ipcRenderer.invoke('save-video-locally', opts),
  copyToComfyUIInput: (p) => ipcRenderer.invoke('copy-to-comfyui-input', p),
  comfyLaunch: (opts) => ipcRenderer.invoke('comfy-launch', opts),

  // VLM server management
  vlmSetup: (opts) => ipcRenderer.invoke('vlm-setup', opts),
  vlmStart: (opts) => ipcRenderer.invoke('vlm-start', opts),
  vlmStop: () => ipcRenderer.invoke('vlm-stop'),
  vlmRunning: () => ipcRenderer.invoke('vlm-running'),
  vlmSystemInfo: () => ipcRenderer.invoke('vlm-system-info'),

  // Voice server management (Whisper.cpp STT + Piper TTS)
  voiceSetup: (opts) => ipcRenderer.invoke('voice-setup', opts),
  voiceStart: (opts) => ipcRenderer.invoke('voice-start', opts),
  voiceStop: () => ipcRenderer.invoke('voice-stop'),
  voiceRunning: () => ipcRenderer.invoke('voice-running'),

  // Log forwarding (from main → renderer)
  onLogMessage: (callback) => {
    ipcRenderer.on('log-message', (_, data) => callback(data));
    return () => ipcRenderer.removeAllListeners('log-message');
  },
  vlmRamCheck: () => ipcRenderer.invoke('vlm-ram-check'),

  // ComfyUI management
  installComfyUI: () => ipcRenderer.invoke('install-comfyui'),
  verifyComfyUI: (p) => ipcRenderer.invoke('verify-comfyui', p),
  comfyUIStart: () => ipcRenderer.invoke('comfyui-start'),
  comfyUIStop: () => ipcRenderer.invoke('comfyui-stop'),
  comfyUIRunning: () => ipcRenderer.invoke('comfyui-running'),
  onComfyUIProgress: (cb) => { ipcRenderer.on('comfyui-install-progress', (_, msg) => cb(msg)); },
});
