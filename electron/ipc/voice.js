// ── Voice Server Process Management (IPC) ──
// Mirrors the VLM setup/start/stop/running pattern but points at voice_server.py.
// The voice server hosts both Whisper.cpp (STT) and Piper (TTS) in one Flask
// process. We keep its venv separate from the VLM's so pywhispercpp + piper-tts
// don't have to coexist with llama-cpp-python's pinned deps.
//
// Exports a `register(deps)` function — same convention as electron/ipc/director.js.

const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

module.exports = function register({ ipcMain, getAppDir, sendLog }) {
  let voiceProcess = null;

  function getVoiceVenvDir() { return path.join(getAppDir(), 'voice_venv'); }
  function getVoiceVenvPython() {
    const venvDir = getVoiceVenvDir();
    return process.platform === 'win32'
      ? path.join(venvDir, 'Scripts', 'python.exe')
      : path.join(venvDir, 'bin', 'python');
  }

  // ── Setup: venv + pip install ──
  ipcMain.handle('voice-setup', async (_, { pythonPath } = {}) => {
    const venvDir = getVoiceVenvDir();
    const venvPy = getVoiceVenvPython();
    const py = pythonPath || 'python';

    try {
      if (!fs.existsSync(venvPy)) {
        console.log('[Voice] Creating Python venv...');
        sendLog('voice', 'Creating voice_venv...');
        execFileSync(py, ['-m', 'venv', venvDir], { stdio: 'pipe', timeout: 60000 });
        execFileSync(venvPy, ['-m', 'pip', 'install', '--upgrade', 'pip', '--quiet'], { stdio: 'pipe', timeout: 60000 });
      }

      // Check the essentials. piper-tts pulls in onnxruntime which is big, so
      // we verify it separately to avoid a needless reinstall on every boot.
      // sounddevice is for server-side recording (we moved off getUserMedia
      // after it was crashing the renderer on some Windows Electron builds).
      // kokoro + soundfile are the new default TTS engine (more natural than
      // Piper). Piper stays in the venv as a fallback so users who already
      // downloaded a Piper voice aren't forced to re-download weights.
      const checks = ['flask', 'numpy', 'requests', 'pywhispercpp', 'piper', 'sounddevice', 'kokoro', 'soundfile'];
      let missing = false;
      for (const pkg of checks) {
        try { execFileSync(venvPy, ['-c', `import ${pkg}`], { stdio: 'pipe', timeout: 5000 }); }
        catch { missing = true; break; }
      }

      if (missing) {
        console.log('[Voice] Installing dependencies (flask, numpy, requests, pywhispercpp, piper-tts, sounddevice, kokoro, soundfile)...');
        sendLog('voice', 'Installing voice dependencies — can take a minute or two (kokoro pulls torch on first install)...');
        execFileSync(
          venvPy,
          ['-m', 'pip', 'install',
            'flask', 'numpy', 'requests', 'pywhispercpp', 'piper-tts',
            'sounddevice', 'kokoro', 'soundfile',
            '--quiet'],
          { stdio: 'pipe', timeout: 600000 },  // 10 min — kokoro pulls torch on some platforms
        );
        sendLog('voice', 'Voice dependencies installed.');
      }

      return { status: 'ok', python: venvPy };
    } catch (err) {
      console.error('[Voice] Setup error:', err);
      return { error: `Voice setup failed: ${err.message}` };
    }
  });

  // ── Start: spawn voice_server.py on port 5124 ──
  ipcMain.handle('voice-start', async (_, { pythonPath, whisperPath, piperPath, engine, kokoroVoice } = {}) => {
    if (voiceProcess) return { status: 'already_running' };
    const serverScript = path.join(getAppDir(), 'voice_server.py');
    if (!fs.existsSync(serverScript)) return { error: 'voice_server.py not found' };

    const venvPy = getVoiceVenvPython();
    const py = fs.existsSync(venvPy) ? venvPy : (pythonPath || 'python');
    console.log('[Voice] Starting server with:', py);

    const args = [serverScript, '--port', '5124'];
    if (whisperPath) args.push('--whisper', whisperPath);
    if (piperPath) args.push('--piper', piperPath);
    if (engine) args.push('--engine', engine);
    if (kokoroVoice) args.push('--kokoro-voice', kokoroVoice);

    return new Promise((resolve) => {
      voiceProcess = spawn(py, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PYTHONUNBUFFERED: '1' },
        windowsHide: true,
      });
      let started = false;
      const onData = (data) => {
        const lines = data.toString().split('\n').filter(l => l.trim());
        for (const line of lines) {
          console.log('[Voice]', line);
          sendLog('voice', line);
        }
        if (!started && data.toString().includes('Running on')) {
          started = true;
          resolve({ status: 'ok' });
        }
      };
      voiceProcess.stdout.on('data', onData);
      voiceProcess.stderr.on('data', onData);
      voiceProcess.on('error', (err) => {
        voiceProcess = null;
        if (!started) resolve({ error: err.message });
      });
      voiceProcess.on('exit', (code) => {
        console.log(`[Voice] Server exited with code ${code}`);
        voiceProcess = null;
      });
      setTimeout(() => { if (!started) resolve({ error: 'Voice server start timeout (30s)' }); }, 30000);
    });
  });

  // ── Stop ──
  ipcMain.handle('voice-stop', async () => {
    if (voiceProcess) {
      try {
        if (process.platform === 'win32') {
          spawn('taskkill', ['/pid', String(voiceProcess.pid), '/f', '/t'], { windowsHide: true });
        } else {
          voiceProcess.kill();
        }
      } catch {}
      voiceProcess = null;
    }
    return { status: 'ok' };
  });

  ipcMain.handle('voice-running', () => ({ running: voiceProcess !== null }));

  // Expose an accessor so main.js's app-quit handler can clean up the process
  // the same way it already does for the VLM.
  return {
    killVoiceProcess() {
      if (voiceProcess) {
        try {
          if (process.platform === 'win32') {
            spawn('taskkill', ['/pid', String(voiceProcess.pid), '/f', '/t'], { windowsHide: true });
          } else {
            voiceProcess.kill();
          }
        } catch {}
        voiceProcess = null;
      }
    },
  };
};
