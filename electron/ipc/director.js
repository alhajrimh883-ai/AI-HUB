// ── Director Project System (IPC) ──
// Extracted from electron/main.js to keep the main file manageable.
// Each project has: project.json, start_image.png (optional), current.mp4, current.latent
//
// This module exports a `register(deps)` function. Dependencies that are
// mutable in main.js (like comfyuiPath) are passed as getter functions so this
// module always reads the current value.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

module.exports = function register({ ipcMain, getOutputDir, getComfyuiPath, getFFmpegPath }) {
  function getDirectorProjectDir(sessionId) {
    const base = path.join(getOutputDir(), 'director_projects', sessionId);
    if (!fs.existsSync(base)) fs.mkdirSync(base, { recursive: true });
    return base;
  }

  // Save/update project metadata
  ipcMain.handle('director-save-project', async (_, { sessionId, metadata }) => {
    try {
      const projDir = getDirectorProjectDir(sessionId);
      const jsonPath = path.join(projDir, 'project.json');
      fs.writeFileSync(jsonPath, JSON.stringify(metadata, null, 2), 'utf8');
      return { ok: true };
    } catch (e) { return { ok: false, error: e.message }; }
  });

  // Load project metadata
  ipcMain.handle('director-load-project', async (_, sessionId) => {
    try {
      const jsonPath = path.join(getDirectorProjectDir(sessionId), 'project.json');
      if (!fs.existsSync(jsonPath)) return null;
      return JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    } catch { return null; }
  });

  // List all director projects
  ipcMain.handle('director-list-projects', async () => {
    try {
      const base = path.join(getOutputDir(), 'director_projects');
      if (!fs.existsSync(base)) return [];
      return fs.readdirSync(base, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => {
          const projDir = path.join(base, d.name);
          const jsonPath = path.join(projDir, 'project.json');
          let meta = null;
          try { meta = JSON.parse(fs.readFileSync(jsonPath, 'utf8')); } catch {}
          // Find actual files by extension (named {sessionId}.latent, {sessionId}.mp4)
          const files = fs.readdirSync(projDir);
          const hasLatent = files.some(f => f.endsWith('.latent'));
          const hasVideo = files.some(f => f.endsWith('.mp4'));
          const hasImage = files.some(f => f === 'start_image.png');
          const videoFile = files.find(f => f.endsWith('.mp4'));
          const videoPath = videoFile ? path.join(projDir, videoFile) : null;
          const videoSize = videoPath && fs.existsSync(videoPath) ? fs.statSync(videoPath).size : 0;
          return { id: d.name, meta, hasLatent, hasVideo, hasImage, videoFile, videoSize, projDir };
        })
        .sort((a, b) => (b.meta?.updatedAt || 0) - (a.meta?.updatedAt || 0));
    } catch { return []; }
  });

  // Save start image to project folder
  ipcMain.handle('director-save-image', async (_, { sessionId, comfyFilename, comfySubfolder, comfyType }) => {
    try {
      const projDir = getDirectorProjectDir(sessionId);
      const dstPath = path.join(projDir, 'start_image.png');
      // Download from ComfyUI
      const url = `http://127.0.0.1:8188/view?filename=${encodeURIComponent(comfyFilename)}&subfolder=${encodeURIComponent(comfySubfolder || '')}&type=${comfyType || 'output'}`;
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`Download failed: ${resp.status}`);
      const buf = Buffer.from(await resp.arrayBuffer());
      fs.writeFileSync(dstPath, buf);
      return { ok: true, path: dstPath, size: buf.length };
    } catch (e) { return { ok: false, error: e.message }; }
  });

  // Save video from ComfyUI output to project folder
  ipcMain.handle('director-save-video', async (_, { sessionId, comfyFilename, comfySubfolder, comfyType }) => {
    try {
      const projDir = getDirectorProjectDir(sessionId);
      const dstPath = path.join(projDir, `${sessionId}.mp4`);
      const url = `http://127.0.0.1:8188/view?filename=${encodeURIComponent(comfyFilename)}&subfolder=${encodeURIComponent(comfySubfolder || 'video')}&type=${comfyType || 'output'}`;
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`Download failed: ${resp.status}`);
      const buf = Buffer.from(await resp.arrayBuffer());
      fs.writeFileSync(dstPath, buf);
      return { ok: true, path: dstPath, size: buf.length };
    } catch (e) { return { ok: false, error: e.message }; }
  });

  // Push latent from project folder → ComfyUI input/ (for LoadLatent)
  // Find latest file matching extension in project folder
  function findLatestInProject(projDir, ext) {
    try {
      const files = fs.readdirSync(projDir)
        .filter(f => f.endsWith(ext))
        .map(f => ({ name: f, time: fs.statSync(path.join(projDir, f)).mtimeMs }))
        .sort((a, b) => b.time - a.time);
      return files[0]?.name || null;
    } catch { return null; }
  }

  ipcMain.handle('director-push-latent', async (_, { sessionId, targetName }) => {
    try {
      const projDir = getDirectorProjectDir(sessionId);
      const latentFile = findLatestInProject(projDir, '.latent');
      if (!latentFile) return { ok: false, error: `No .latent file in project folder: ${projDir}` };

      const srcPath = path.join(projDir, latentFile);
      const comfyInput = path.join(getComfyuiPath(), 'input');
      if (!fs.existsSync(comfyInput)) fs.mkdirSync(comfyInput, { recursive: true });
      const dstName = targetName || `${sessionId}.latent`;
      const dstPath = path.join(comfyInput, dstName);
      fs.copyFileSync(srcPath, dstPath);

      if (!fs.existsSync(dstPath)) return { ok: false, error: 'Copy failed' };
      return { ok: true, latentName: dstName, comfyPath: dstPath, size: fs.statSync(dstPath).size };
    } catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('director-push-video', async (_, { sessionId, targetName }) => {
    try {
      const projDir = getDirectorProjectDir(sessionId);
      const videoFile = findLatestInProject(projDir, '.mp4');
      if (!videoFile) return { ok: false, error: `No .mp4 file in project folder: ${projDir}` };

      const srcPath = path.join(projDir, videoFile);
      const comfyInput = path.join(getComfyuiPath(), 'input');
      if (!fs.existsSync(comfyInput)) fs.mkdirSync(comfyInput, { recursive: true });
      const dstName = targetName || `${sessionId}.mp4`;
      const dstPath = path.join(comfyInput, dstName);
      fs.copyFileSync(srcPath, dstPath);

      if (!fs.existsSync(dstPath)) return { ok: false, error: 'Copy failed' };
      return { ok: true, videoName: dstName, comfyPath: dstPath, size: fs.statSync(dstPath).size };
    } catch (e) { return { ok: false, error: e.message }; }
  });

  // Get project folder path (for serving files to UI)
  ipcMain.handle('director-get-project-path', async (_, sessionId) => {
    return getDirectorProjectDir(sessionId);
  });

  // Get file:// URL for a project video (for preview in Gallery/Resume overlay)
  ipcMain.handle('director-get-video-url', async (_, sessionId) => {
    try {
      const projDir = getDirectorProjectDir(sessionId);
      const files = fs.readdirSync(projDir).filter(f => f.endsWith('.mp4'));
      if (files.length === 0) return null;
      const filePath = path.join(projDir, files[0]);
      // Convert to file:// URL (handles Windows backslashes)
      return 'file:///' + filePath.replace(/\\/g, '/');
    } catch { return null; }
  });

  // Save a video clip to project clips/ subfolder
  // Each segment saves its own clip — no re-encoding of previous content
  ipcMain.handle('director-save-clip', async (_, { sessionId, clipIndex, comfyFilename, comfySubfolder, comfyType }) => {
    try {
      const projDir = getDirectorProjectDir(sessionId);
      const clipsDir = path.join(projDir, 'clips');
      if (!fs.existsSync(clipsDir)) fs.mkdirSync(clipsDir, { recursive: true });

      const clipName = `clip_${String(clipIndex).padStart(4, '0')}.mp4`;
      const dstPath = path.join(clipsDir, clipName);

      const url = `http://127.0.0.1:8188/view?filename=${encodeURIComponent(comfyFilename)}&subfolder=${encodeURIComponent(comfySubfolder || 'video')}&type=${comfyType || 'output'}`;
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`Download failed: ${resp.status}`);
      const buf = Buffer.from(await resp.arrayBuffer());
      fs.writeFileSync(dstPath, buf);

      return { ok: true, clipName, path: dstPath, size: buf.length };
    } catch (e) { return { ok: false, error: e.message }; }
  });

  // Concat all clips in project using ffmpeg -c copy (no re-encoding)
  // Then push result to ComfyUI input/ for next segment
  ipcMain.handle('director-concat-clips', async (_, { sessionId, targetName }) => {
    try {
      const projDir = getDirectorProjectDir(sessionId);
      const clipsDir = path.join(projDir, 'clips');
      if (!fs.existsSync(clipsDir)) return { ok: false, error: 'No clips directory' };

      // Find the latest clip (just saved)
      const clips = fs.readdirSync(clipsDir)
        .filter(f => f.startsWith('clip_') && f.endsWith('.mp4'))
        .sort();
      if (clips.length === 0) return { ok: false, error: 'No clips found' };

      const latestClip = path.join(clipsDir, clips[clips.length - 1]);
      const accPath = path.join(projDir, `${sessionId}.mp4`);
      const comfyInput = path.join(getComfyuiPath(), 'input');
      if (!fs.existsSync(comfyInput)) fs.mkdirSync(comfyInput, { recursive: true });
      const dstName = targetName || `${sessionId}.mp4`;
      const dstPath = path.join(comfyInput, dstName);

      // First clip ever — just becomes the accumulated video
      if (!fs.existsSync(accPath)) {
        fs.copyFileSync(latestClip, accPath);
        fs.copyFileSync(accPath, dstPath);
        // Delete clip
        try { fs.unlinkSync(latestClip); } catch {}
        return { ok: true, videoName: dstName, clipCount: 1, comfyPath: dstPath, size: fs.statSync(accPath).size };
      }

      // Concat: accumulated + latest clip → new accumulated (-c copy, no re-encoding)
      const ffmpeg = getFFmpegPath();
      if (!ffmpeg) return { ok: false, error: 'ffmpeg not found. Restart the app to auto-install.' };

      const listPath = path.join(clipsDir, 'concat_list.txt');
      fs.writeFileSync(listPath, `file '${accPath.replace(/\\/g, '/').replace(/'/g, "'\\''")}'\nfile '${latestClip.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`);

      const tmpPath = accPath + '.tmp.mp4';
      try {
        execSync(`"${ffmpeg}" -y -f concat -safe 0 -i "${listPath}" -c copy "${tmpPath}"`, {
          timeout: 120000, stdio: 'pipe',
        });
        if (fs.existsSync(tmpPath)) {
          if (fs.existsSync(accPath)) fs.unlinkSync(accPath);
          fs.renameSync(tmpPath, accPath);
        }
      } catch (ffErr) {
        if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
        return { ok: false, error: `ffmpeg concat failed: ${ffErr.message}` };
      }

      // Delete clip + list — accumulated is the only file that matters
      try { fs.unlinkSync(latestClip); } catch {}
      try { fs.unlinkSync(listPath); } catch {}

      // Push accumulated to ComfyUI input/
      fs.copyFileSync(accPath, dstPath);

      return { ok: true, videoName: dstName, clipCount: clips.length, comfyPath: dstPath, size: fs.statSync(accPath).size };
    } catch (e) { return { ok: false, error: e.message }; }
  });

  // Grab latent from ComfyUI output/ → project folder
  // SaveLatent writes to output/{prefix}_00001_.latent (prefix can include subdirs)
  ipcMain.handle('director-grab-latent', async (_, { sessionId, prefix }) => {
    try {
      const comfyOutput = path.join(getComfyuiPath(), 'output');
      if (!fs.existsSync(comfyOutput)) return { ok: false, error: 'ComfyUI output/ not found' };

      // Search recursively for .latent files matching prefix
      const findLatents = (dir, collected = []) => {
        try {
          for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) findLatents(full, collected);
            else if (entry.name.endsWith('.latent') && full.includes(prefix)) collected.push(full);
          }
        } catch {}
        return collected;
      };

      const found = findLatents(comfyOutput).sort().reverse();
      if (found.length === 0) {
        // Debug: list what IS in output
        const allLatents = findLatents(comfyOutput.replace(prefix, '')).map(f => path.relative(comfyOutput, f)).slice(0, 10);
        return { ok: false, error: `No latent matching "${prefix}" in output/. Found: [${allLatents.join(', ')}]` };
      }

      const srcPath = found[0];
      const projDir = getDirectorProjectDir(sessionId);
      const dstPath = path.join(projDir, 'current.latent');
      fs.copyFileSync(srcPath, dstPath);

      // Clean up session latents from output/
      for (const f of found) { try { fs.unlinkSync(f); } catch {} }

      return { ok: true, projectPath: dstPath, size: fs.statSync(dstPath).size, source: path.relative(comfyOutput, srcPath) };
    } catch (e) { return { ok: false, error: e.message }; }
  });
};
