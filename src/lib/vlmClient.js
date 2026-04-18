/**
 * VLM Client — Communicates with the local llama-cpp-python VLM server.
 * The server runs as a subprocess managed by Electron.
 */

import { freeVram, freeAll } from './comfyui';

const VLM_BASE = 'http://127.0.0.1:5123';

/**
 * Check if VLM server is running.
 */
export async function checkVlmServer() {
  try {
    const r = await fetch(`${VLM_BASE}/status`, { signal: AbortSignal.timeout(2000) });
    return r.ok;
  } catch { return false; }
}

/**
 * Get VLM server status.
 */
export async function getVlmStatus() {
  const r = await fetch(`${VLM_BASE}/status`);
  return r.json();
}

/**
 * Load a model into GPU.
 * @param {Object} opts - { model_path, mmproj_path, ctx, gpu_layers }
 */
export async function loadModel(opts) {
  const r = await fetch(`${VLM_BASE}/load`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(opts),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || 'Load failed');
  return data;
}

/**
 * Run VLM inference: image + prompt → generated text.
 * Handles loading/re-layering automatically if model is parked.
 * @param {Object} opts - { image_base64, user_prompt, system_prompt, max_tokens }
 * @returns {Promise<string>} Generated text
 */
export async function infer(opts) {
  const r = await fetch(`${VLM_BASE}/infer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(opts),
  });
  const data = await r.json();
  console.log('[VLM Client] /infer response:', { ok: r.ok, text_len: data.text?.length, handler: data.handler, error: data.error });
  if (!r.ok) throw new Error(data.error || 'Inference failed');
  return data.text;
}

/**
 * Chat-style inference with full message history.
 * @param {Array} messages — [{role: 'user'|'assistant'|'system', content: string|Array}]
 * @param {number} maxTokens
 * @returns {string} VLM response text
 */
export async function chatInfer(messages, maxTokens = 2048) {
  const r = await fetch(`${VLM_BASE}/chat-infer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages, max_tokens: maxTokens }),
  });
  const data = await r.json();
  console.log('[VLM Client] /chat-infer response:', { ok: r.ok, turns: messages.length, text_len: data.text?.length, error: data.error });
  if (!r.ok) throw new Error(data.error || 'Chat inference failed');
  return data.text;
}

/**
 * Park model — move from VRAM to RAM (n_gpu_layers=0).
 * VRAM freed, model stays in RAM for fast reload.
 */
export async function parkModel() {
  const r = await fetch(`${VLM_BASE}/park`, { method: 'POST' });
  return r.json();
}

/**
 * Smart park — only parks if VLM is currently loaded in VRAM.
 * Safe to call before ComfyUI generation to free VRAM.
 * No-op if server isn't running or model is already parked/unloaded.
 */
export async function parkVlmIfLoaded() {
  try {
    const status = await getVlmStatus();
    if (status.state === 'loaded') {
      await parkModel();
      console.log('[VLM] Parked before ComfyUI generation');
    }
  } catch {
    // Server not running — nothing to park
  }
}

/**
 * Fully unload model — free VRAM and RAM.
 */
export async function unloadModel() {
  const r = await fetch(`${VLM_BASE}/unload`, { method: 'POST' });
  return r.json();
}

/**
 * Ensure VLM server is running. Sets up venv + installs deps on first use.
 */
export async function ensureVlmServer(pythonPath, onStatus) {
  if (!window.electronAPI) throw new Error('Not in Electron');
  const { running } = await window.electronAPI.vlmRunning();
  if (running) {
    try { await getVlmStatus(); return; } catch { /* server crashed, restart */ }
  }
  onStatus?.('Setting up VLM environment...');
  const setup = await window.electronAPI.vlmSetup({ pythonPath: pythonPath || 'python' });
  if (setup.error) throw new Error(setup.error);
  onStatus?.('Starting VLM server...');
  const start = await window.electronAPI.vlmStart({ pythonPath: pythonPath || 'python' });
  if (start.error) throw new Error(start.error);
  for (let i = 0; i < 10; i++) {
    try { await getVlmStatus(); return; } catch { await new Promise(r => setTimeout(r, 500)); }
  }
  throw new Error('VLM server failed to respond');
}

/**
 * Full VLM pipeline: ensure server → load → infer → park/unload.
 */
export async function runVlmPipeline(opts) {
  const { modelPath, mmprojPath, ctx, imageTokens, imageBase64, userPrompt, systemPrompt, afterInference, onStatus, pythonPath } = opts;

  // Ensure server is running (auto-setup on first use)
  await ensureVlmServer(pythonPath, onStatus);

  // ── Safety: Free VRAM before loading VLM ──
  onStatus?.('Freeing VRAM for VLM...');
  await freeVram(); // tell ComfyUI to move models from VRAM → RAM

  // Check RAM pressure — if critical, tell ComfyUI to fully unload
  if (window.electronAPI?.vlmRamCheck) {
    const ram = await window.electronAPI.vlmRamCheck();
    console.log(`[VLM] RAM: ${ram.freeGB}GB free / ${ram.totalGB}GB total (${ram.usedPercent}% used)`);
    if (ram.critical) {
      onStatus?.(`RAM critical (${ram.usedPercent}%) — freeing ComfyUI memory...`);
      await freeAll(); // fully unload ComfyUI models from RAM too
      // Small delay to let memory settle
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  // Check if model needs loading
  onStatus?.('Checking VLM model...');
  let status;
  try { status = await getVlmStatus(); } catch { status = { state: 'unloaded' }; }

  if (status.state === 'unloaded' || status.model !== modelPath?.split(/[/\\]/).pop()) {
    onStatus?.('Loading VLM model...');
    await loadModel({ model_path: modelPath, mmproj_path: mmprojPath, ctx, image_tokens: imageTokens || 1024, gpu_layers: -1 });
  } else if (status.state === 'parked') {
    // Check if ctx or tokens changed — if so, reload instead of just re-layering
    if (status.ctx !== ctx || status.image_tokens !== (imageTokens || 1024)) {
      onStatus?.('Reloading VLM with new settings...');
      await loadModel({ model_path: modelPath, mmproj_path: mmprojPath, ctx, image_tokens: imageTokens || 1024, gpu_layers: -1 });
    } else {
      onStatus?.('Re-layering VLM to GPU...');
      // Infer endpoint handles re-layering automatically
    }
  } else if (status.state === 'loaded' && (status.ctx !== ctx || status.image_tokens !== (imageTokens || 1024))) {
    // Already loaded but settings changed — reload
    onStatus?.('Reloading VLM with new settings...');
    await loadModel({ model_path: modelPath, mmproj_path: mmprojPath, ctx, image_tokens: imageTokens || 1024, gpu_layers: -1 });
  }

  // Infer
  onStatus?.('VLM analyzing image...');
  const text = await infer({
    image_base64: imageBase64,
    user_prompt: userPrompt,
    system_prompt: systemPrompt || '',
    max_tokens: 2048,
  });

  console.log('[VLM Client] Received text:', text ? `${text.length} chars: "${text.substring(0, 100)}..."` : 'EMPTY');

  // After inference: park, unload, or keep
  const mode = afterInference || 'park';
  if (mode === 'park') {
    onStatus?.('Parking VLM in RAM...');
    await parkModel();
  } else if (mode === 'unload') {
    onStatus?.('Unloading VLM...');
    await unloadModel();
  }
  // 'keep' = leave loaded in VRAM

  onStatus?.('VLM done');
  return text;
}

// ══════════════════════════════════════════════════════════════
// VIDEO FRAME EXTRACTION
// ══════════════════════════════════════════════════════════════

/**
 * Calculate frame timestamps with weighted distribution.
 * Short videos: even spacing. Long videos: weighted toward the end.
 */
function getFrameTimestamps(duration, numFrames) {
  if (duration <= 10) {
    // Short: even spacing
    return Array.from({ length: numFrames }, (_, i) =>
      (duration / (numFrames + 1)) * (i + 1));
  }

  // Long: 30% of frames from first 70% (context), 70% from last 30% (detail)
  const contextCount = Math.max(1, Math.ceil(numFrames * 0.3));
  const detailCount = numFrames - contextCount;
  const splitPoint = duration * 0.7;

  const context = Array.from({ length: contextCount }, (_, i) =>
    (splitPoint / (contextCount + 1)) * (i + 1));
  const detail = Array.from({ length: detailCount }, (_, i) =>
    splitPoint + ((duration - splitPoint) / (detailCount + 1)) * (i + 1));

  return [...context, ...detail];
}

/**
 * Extract frames from a video URL using canvas.
 * @param {string} videoUrl - URL of the video (ComfyUI URL or file:// URL)
 * @param {number} numFrames - number of frames to extract
 * @param {function} onStatus - progress callback
 * @returns {Promise<{frames: string[], lastFrame: string, duration: number}>}
 */
export async function extractVideoFrames(videoUrl, numFrames = 4, onStatus) {
  onStatus?.(`Extracting ${numFrames} frames from video...`);

  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    video.crossOrigin = 'anonymous';
    video.muted = true;
    video.preload = 'auto';

    video.onerror = () => reject(new Error('Failed to load video for frame extraction'));

    video.onloadedmetadata = async () => {
      const duration = video.duration;
      const canvas = document.createElement('canvas');

      // Scale down large videos to save tokens (max 720p)
      const scale = Math.min(1, 720 / Math.max(video.videoWidth, video.videoHeight));
      canvas.width = Math.round(video.videoWidth * scale);
      canvas.height = Math.round(video.videoHeight * scale);
      const ctx = canvas.getContext('2d');

      console.log(`[VLM] Extracting frames: ${duration.toFixed(1)}s video, ${numFrames} frames, ${canvas.width}x${canvas.height}`);

      const timestamps = getFrameTimestamps(duration, numFrames);
      const frames = [];

      // Extract each frame
      for (let i = 0; i < timestamps.length; i++) {
        onStatus?.(`Extracting frame ${i + 1}/${numFrames} (${timestamps[i].toFixed(1)}s)...`);
        video.currentTime = timestamps[i];
        await new Promise(r => { video.onseeked = r; });
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        frames.push(canvas.toDataURL('image/jpeg', 0.75).split(',')[1]);
      }

      // Always grab last frame (for Phase 2)
      onStatus?.('Extracting last frame...');
      video.currentTime = Math.max(0, duration - 0.1);
      await new Promise(r => { video.onseeked = r; });
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const lastFrame = canvas.toDataURL('image/jpeg', 0.75).split(',')[1];

      video.remove();
      canvas.remove();

      console.log(`[VLM] Extracted ${frames.length} frames + last frame (${(frames.reduce((s, f) => s + f.length, 0) / 1024).toFixed(0)}KB total)`);
      resolve({ frames, lastFrame, duration });
    };

    video.src = videoUrl;
  });
}

// ══════════════════════════════════════════════════════════════
// 2-PHASE VIDEO ANALYSIS PIPELINE
// ══════════════════════════════════════════════════════════════

/**
 * Run 2-phase video analysis:
 *   Phase 1: Multiple frames → video summary
 *   Phase 2: Last frame + summary + user template → video prompt
 *
 * @param {Object} opts
 * @param {string} opts.videoUrl - URL of the video to analyze
 * @param {number} opts.targetFrames - number of frames for Phase 1
 * @param {string} opts.userPrompt - user's prompt template (with markers)
 * @param {string} opts.modelPath, opts.mmprojPath, opts.ctx, opts.imageTokens
 * @param {string} opts.afterInference - 'park' | 'unload' | 'keep'
 * @param {function} opts.onStatus - status callback
 * @param {string} opts.pythonPath
 * @returns {Promise<string>} Generated video prompt
 */
export async function runVideoAnalysisPipeline(opts) {
  const {
    videoUrl, targetFrames, userPrompt,
    modelPath, mmprojPath, ctx, imageTokens,
    afterInference, onStatus, pythonPath, onPhaseComplete,
  } = opts;

  // Ensure server is running
  await ensureVlmServer(pythonPath, onStatus);

  // Free VRAM for VLM
  onStatus?.('Freeing VRAM for VLM...');
  await freeVram();

  // Load model if needed
  onStatus?.('Checking VLM model...');
  let status;
  try { status = await getVlmStatus(); } catch { status = { state: 'unloaded' }; }
  if (status.state === 'unloaded' || status.model !== modelPath?.split(/[/\\]/).pop()) {
    onStatus?.('Loading VLM model...');
    await loadModel({ model_path: modelPath, mmproj_path: mmprojPath, ctx, image_tokens: imageTokens || 1024, gpu_layers: -1 });
  } else if (status.state === 'parked' || status.ctx !== ctx || status.image_tokens !== (imageTokens || 1024)) {
    onStatus?.('Reloading VLM with current settings...');
    await loadModel({ model_path: modelPath, mmproj_path: mmprojPath, ctx, image_tokens: imageTokens || 1024, gpu_layers: -1 });
  }

  // ── Extract frames ──
  const { frames, lastFrame, duration } = await extractVideoFrames(videoUrl, targetFrames, onStatus);
  onPhaseComplete?.('frames', null, [...frames, lastFrame]);

  // ── Phase 1: Multi-frame video summary ──
  onStatus?.(`Phase 1: Analyzing ${frames.length} frames...`);
  const summaryPrompt = `You are watching ${frames.length} frames from a ${duration.toFixed(1)} second video, evenly sampled from start to end.

Describe what happens in this video in 2-3 sentences. Focus on:
- The subject(s) and their appearance
- The action/movement that occurs
- The setting/environment
- Any camera movement

Be concise and specific. Output ONLY the description, nothing else.`;

  const summary = await infer({
    images_base64: frames,
    user_prompt: summaryPrompt,
    max_tokens: 512,
  });

  console.log('[VLM] Phase 1 summary:', summary);
  onPhaseComplete?.('summary', summary);

  // ── Phase 2: Last frame + summary → continuation prompt ──
  onStatus?.('Phase 2: Generating continuation prompt...');
  const continuationPrompt = `PREVIOUS VIDEO CONTEXT:
${summary}

Now look at this frame — it is the LAST FRAME of that video. Generate a prompt that continues the action naturally from this point.

${userPrompt}`;

  const videoPrompt = await infer({
    image_base64: lastFrame,
    user_prompt: continuationPrompt,
    max_tokens: 2048,
  });

  console.log('[VLM] Phase 2 prompt:', videoPrompt?.substring(0, 150));
  onPhaseComplete?.('prompt', videoPrompt);

  // After inference: park, unload, or keep
  const mode = afterInference || 'park';
  if (mode === 'park') {
    onStatus?.('Parking VLM in RAM...');
    await parkModel();
  } else if (mode === 'unload') {
    onStatus?.('Unloading VLM...');
    await unloadModel();
  }

  onStatus?.('Video analysis complete');
  return videoPrompt;
}

/**
 * Run single-frame video analysis (V2V simple mode).
 * Extracts last frame only, sends to standard VLM pipeline.
 */
export async function runSingleFrameVideoPipeline(opts) {
  const { videoUrl, onStatus, ...rest } = opts;
  const { lastFrame } = await extractVideoFrames(videoUrl, 1, onStatus);
  return runVlmPipeline({
    ...rest,
    imageBase64: lastFrame,
    onStatus,
  });
}

// ══════════════════════════════════════════════════════════════
// FULL AUTO PIPELINE (Tags → Prompt)
// ══════════════════════════════════════════════════════════════

const TAG_PROMPT = `Analyze this image and generate a comprehensive set of booru-style tags that describe it. Include tags for:
- Subject (1girl, 1boy, animal, object, etc.)
- Appearance (hair color, clothing, pose, expression)
- Action/movement (walking, sitting, reaching, looking_at_viewer)
- Setting/environment (outdoors, garden, city, interior)
- Lighting/mood (warm_lighting, dramatic_shadows, golden_hour)
- Camera (close_up, wide_shot, low_angle, dutch_angle)

Output ONLY comma-separated tags. No explanations. No sentences. Example format:
1girl, brown_hair, white_dress, walking, garden, rain, warm_lighting, medium_shot`;

const TAG_TO_PROMPT = `You are given a set of descriptive tags and must write a cinematic video prompt.

TAGS:
{tags}

Write a single, detailed, cinematic paragraph describing a video scene based on these tags. Include:
- Subject description (appearance, clothing, expression)  
- Action and movement (what happens, how they move)
- Environment and atmosphere
- Camera movement and framing
- Lighting and color mood

Write ONLY the prompt paragraph. No intro, no bullet points.`;

/**
 * Full Auto I2V: image → tags → prompt
 */
export async function runFullAutoI2V(opts) {
  const {
    imageBase64, modelPath, mmprojPath, ctx, imageTokens,
    afterInference, onStatus, pythonPath, onPhaseComplete,
  } = opts;

  await ensureVlmServer(pythonPath, onStatus);
  onStatus?.('Freeing VRAM for VLM...');
  await freeVram();

  onStatus?.('Checking VLM model...');
  let status;
  try { status = await getVlmStatus(); } catch { status = { state: 'unloaded' }; }
  if (status.state === 'unloaded' || status.model !== modelPath?.split(/[/\\]/).pop()) {
    onStatus?.('Loading VLM model...');
    await loadModel({ model_path: modelPath, mmproj_path: mmprojPath, ctx, image_tokens: imageTokens || 1024, gpu_layers: -1 });
  } else if (status.state === 'parked' || status.ctx !== ctx || status.image_tokens !== (imageTokens || 1024)) {
    onStatus?.('Reloading VLM with current settings...');
    await loadModel({ model_path: modelPath, mmproj_path: mmprojPath, ctx, image_tokens: imageTokens || 1024, gpu_layers: -1 });
  }

  // Phase 1: Image → Tags
  onStatus?.('Phase 1: Generating tags...');
  const tags = await infer({
    image_base64: imageBase64,
    user_prompt: TAG_PROMPT,
    max_tokens: 512,
  });
  console.log('[VLM] Tags:', tags);
  onPhaseComplete?.('tags', tags);

  // Phase 2: Tags → Prompt
  onStatus?.('Phase 2: Building prompt from tags...');
  const prompt = await infer({
    image_base64: imageBase64,
    user_prompt: TAG_TO_PROMPT.replace('{tags}', tags),
    max_tokens: 2048,
  });
  console.log('[VLM] Auto prompt:', prompt?.substring(0, 150));
  onPhaseComplete?.('prompt', prompt);

  const mode = afterInference || 'park';
  if (mode === 'park') { onStatus?.('Parking VLM...'); await parkModel(); }
  else if (mode === 'unload') { onStatus?.('Unloading VLM...'); await unloadModel(); }

  onStatus?.('Full auto complete');
  return prompt;
}

/**
 * Full Auto V2V: frames → summary → tags → prompt
 */
export async function runFullAutoV2V(opts) {
  const {
    videoUrl, targetFrames, modelPath, mmprojPath, ctx, imageTokens,
    afterInference, onStatus, pythonPath, onPhaseComplete,
  } = opts;

  await ensureVlmServer(pythonPath, onStatus);
  onStatus?.('Freeing VRAM for VLM...');
  await freeVram();

  onStatus?.('Checking VLM model...');
  let status;
  try { status = await getVlmStatus(); } catch { status = { state: 'unloaded' }; }
  if (status.state === 'unloaded' || status.model !== modelPath?.split(/[/\\]/).pop()) {
    onStatus?.('Loading VLM model...');
    await loadModel({ model_path: modelPath, mmproj_path: mmprojPath, ctx, image_tokens: imageTokens || 1024, gpu_layers: -1 });
  }

  // Extract frames
  const { frames, lastFrame, duration } = await extractVideoFrames(videoUrl, targetFrames, onStatus);
  onPhaseComplete?.('frames', null, [...frames, lastFrame]);

  // Phase 1: Frames → Summary
  onStatus?.(`Phase 1: Summarizing ${frames.length} frames...`);
  const summary = await infer({
    images_base64: frames,
    user_prompt: `You are watching ${frames.length} frames from a ${duration.toFixed(1)} second video. Describe what happens in 2-3 sentences. Focus on subjects, actions, setting, and camera. Be concise. Output ONLY the description.`,
    max_tokens: 512,
  });
  console.log('[VLM] Summary:', summary);
  onPhaseComplete?.('summary', summary);

  // Phase 2: Last frame → Tags
  onStatus?.('Phase 2: Tagging current scene...');
  const tags = await infer({
    image_base64: lastFrame,
    user_prompt: TAG_PROMPT,
    max_tokens: 512,
  });
  console.log('[VLM] Tags:', tags);
  onPhaseComplete?.('tags', tags);

  // Phase 3: Summary + Tags → Continuation prompt
  onStatus?.('Phase 3: Generating continuation prompt...');
  const prompt = await infer({
    image_base64: lastFrame,
    user_prompt: `PREVIOUS VIDEO: ${summary}

CURRENT SCENE TAGS: ${tags}

Write a cinematic video prompt that CONTINUES naturally from this scene. Describe the next 5-10 seconds of action, maintaining visual consistency. Include subject, action, camera movement, and atmosphere. Write ONLY the prompt paragraph.`,
    max_tokens: 2048,
  });
  console.log('[VLM] Auto V2V prompt:', prompt?.substring(0, 150));
  onPhaseComplete?.('prompt', prompt);

  const mode = afterInference || 'park';
  if (mode === 'park') { onStatus?.('Parking VLM...'); await parkModel(); }
  else if (mode === 'unload') { onStatus?.('Unloading VLM...'); await unloadModel(); }

  onStatus?.('Full auto complete');
  return prompt;
}
