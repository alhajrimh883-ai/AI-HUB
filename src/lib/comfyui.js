/**
 * ComfyUI API Client
 * Handles communication with ComfyUI at http://127.0.0.1:8188
 */

const BASE = 'http://127.0.0.1:8188';
const WS_URL = 'ws://127.0.0.1:8188/ws';

let clientId = crypto.randomUUID();

/**
 * Check if ComfyUI is running.
 */
export async function checkConnection() {
  try {
    const res = await fetch(`${BASE}/system_stats`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Upload an image file to ComfyUI's input directory.
 * @param {File} file - File object
 * @param {string} subfolder - optional subfolder
 * @returns {object} { name, subfolder, type }
 */
export async function uploadImage(file, subfolder = '') {
  const form = new FormData();
  form.append('image', file);
  if (subfolder) form.append('subfolder', subfolder);
  form.append('overwrite', 'true');

  const res = await fetch(`${BASE}/upload/image`, { method: 'POST', body: form });
  if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
  return res.json();
}

/**
 * Upload a video file to ComfyUI's input directory.
 */
export async function uploadVideo(file) {
  // ComfyUI VHS uses the same upload endpoint
  const form = new FormData();
  form.append('image', file); // yes, 'image' key even for video
  form.append('overwrite', 'true');
  form.append('type', 'input');

  const res = await fetch(`${BASE}/upload/image`, { method: 'POST', body: form });
  if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
  return res.json();
}

/**
 * Queue a workflow prompt.
 * @param {object} workflow - API-format workflow
 * @returns {object} { prompt_id }
 */
export async function queuePrompt(workflow) {
  console.log('[ComfyUI] Queueing workflow...');
  const res = await fetch(`${BASE}/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt: workflow,
      client_id: clientId,
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    console.log('[ComfyUI] Queue failed:', err);
    throw new Error(`Queue failed: ${err}`);
  }
  const data = await res.json();
  console.log('[ComfyUI] Workflow queued, prompt_id:', data.prompt_id);
  return data;
}

/**
 * Get execution history for a prompt.
 */
export async function getHistory(promptId) {
  const res = await fetch(`${BASE}/history/${promptId}`);
  if (!res.ok) return null;
  const data = await res.json();
  return data[promptId] || null;
}

/**
 * Get the current queue status.
 */
export async function getQueue() {
  const res = await fetch(`${BASE}/queue`);
  return res.json();
}

/**
 * Interrupt the current execution.
 */
export async function interrupt() {
  await fetch(`${BASE}/interrupt`, { method: 'POST' });
}

/**
 * Free VRAM/RAM.
 */
export async function freeMemory() {
  await fetch(`${BASE}/free`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ unload_models: true, free_memory: true }),
  });
}

/**
 * Create a smart progress tracker for a workflow.
 * Tracks overall progress based on node execution count + sampler step progress.
 *
 * @param {object} workflow - The workflow JSON to analyze
 * @returns {object} tracker with update methods
 */
export function createSmartProgress(workflow) {
  const nodeIds = Object.keys(workflow);
  const totalNodes = nodeIds.length;

  // Identify heavy nodes (KSamplers) — they get weighted more
  const samplerNodes = new Set();
  for (const [nid, node] of Object.entries(workflow)) {
    if ((node.class_type || '').match(/KSampler|SamplerCustom/i)) {
      samplerNodes.add(nid);
    }
  }

  // Weight: sampler nodes are ~10x heavier than regular nodes
  const SAMPLER_WEIGHT = 10;
  const totalWeight = nodeIds.reduce((sum, nid) => sum + (samplerNodes.has(nid) ? SAMPLER_WEIGHT : 1), 0);

  const executedNodes = new Set();
  let currentSamplerNode = null;
  let currentSamplerProgress = 0; // 0-1

  return {
    totalNodes,
    samplerCount: samplerNodes.size,

    /** Call when a node starts executing */
    onExecuting(nodeId) {
      if (nodeId === null) return 1; // execution complete
      // Mark previous sampler as done if we moved to a new node
      if (currentSamplerNode && currentSamplerNode !== nodeId) {
        executedNodes.add(currentSamplerNode);
        currentSamplerNode = null;
        currentSamplerProgress = 0;
      }
      if (samplerNodes.has(nodeId)) {
        currentSamplerNode = nodeId;
        currentSamplerProgress = 0;
      } else {
        executedNodes.add(nodeId);
      }
      return this.getProgress();
    },

    /** Call when sampler reports step progress */
    onProgress(value, max) {
      if (max > 0) currentSamplerProgress = value / max;
      return this.getProgress();
    },

    /** Call when a node finishes */
    onExecuted(nodeId) {
      executedNodes.add(nodeId);
      if (currentSamplerNode === nodeId) {
        currentSamplerNode = null;
        currentSamplerProgress = 0;
      }
      return this.getProgress();
    },

    /** Get current overall progress 0-1 */
    getProgress() {
      let completedWeight = 0;
      for (const nid of executedNodes) {
        completedWeight += samplerNodes.has(nid) ? SAMPLER_WEIGHT : 1;
      }
      // Add partial weight for currently-running sampler
      if (currentSamplerNode && !executedNodes.has(currentSamplerNode)) {
        completedWeight += SAMPLER_WEIGHT * currentSamplerProgress;
      }
      return Math.min(1, completedWeight / totalWeight);
    },
  };
}

/**
 * Connect to ComfyUI WebSocket for real-time progress.
 *
 * @param {object} callbacks
 * @param {function} callbacks.onProgress  - ({value, max, node}) => void
 * @param {function} callbacks.onExecuting - (nodeId) => void
 * @param {function} callbacks.onExecuted  - (nodeId, output) => void
 * @param {function} callbacks.onComplete  - (promptId) => void
 * @param {function} callbacks.onError     - (error) => void
 * @returns {{ close: function }}
 */
export function connectWebSocket(callbacks = {}) {
  const ws = new WebSocket(`${WS_URL}?clientId=${clientId}`);
  let intentionalClose = false;

  ws.onopen = () => console.log('[ComfyUI] WebSocket connected');

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      const { type, data } = msg;

      switch (type) {
        case 'progress':
          if (data.value % 5 === 0 || data.value === data.max) {
            console.log(`[ComfyUI] Progress: ${data.value}/${data.max} (${Math.round(data.value / data.max * 100)}%)`);
          }
          callbacks.onProgress?.(data);
          break;
        case 'executing':
          if (data.node === null) {
            console.log('[ComfyUI] Execution complete');
            callbacks.onComplete?.(data.prompt_id);
          } else {
            console.log(`[ComfyUI] Executing node: ${data.node}`);
            callbacks.onExecuting?.(data.node);
          }
          break;
        case 'executed':
          console.log(`[ComfyUI] Node ${data.node} finished`);
          callbacks.onExecuted?.(data.node, data.output);
          break;
        case 'execution_error':
          console.log('[ComfyUI] Execution error:', data.exception_message || data);
          callbacks.onError?.(data);
          break;
        case 'status':
          break;
      }
    } catch {
      // Binary data (preview images) — ignore
    }
  };

  ws.onerror = (err) => {
    if (!intentionalClose) callbacks.onError?.(err);
  };
  ws.onclose = () => {
    if (!intentionalClose) callbacks.onError?.({ message: 'WebSocket closed' });
  };

  const handle = {
    close: () => {
      intentionalClose = true;
      ws.close();
    },
    ws,
  };

  return handle;
}

/**
 * Get a preview/output image URL.
 */
export function getImageUrl(filename, subfolder = '', type = 'output') {
  return `${BASE}/view?filename=${encodeURIComponent(filename)}&subfolder=${encodeURIComponent(subfolder)}&type=${type}`;
}

/**
 * Get a video output URL.
 */
export function getVideoUrl(filename, subfolder = 'video', type = 'output') {
  return `${BASE}/view?filename=${encodeURIComponent(filename)}&subfolder=${encodeURIComponent(subfolder)}&type=${type}`;
}

/**
 * Query ComfyUI for valid model names via object_info API.
 * Returns the exact list ComfyUI knows about (respects extra_model_paths.yaml).
 */
async function getNodeInputOptions(nodeType, inputName) {
  try {
    const res = await fetch(`${BASE}/object_info/${nodeType}`, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return [];
    const data = await res.json();
    const opts = data[nodeType]?.input?.required?.[inputName]?.[0] || [];
    return Array.isArray(opts) ? opts : [];
  } catch {
    return [];
  }
}

/** Get all checkpoints ComfyUI knows about */
export function getCheckpoints() { return getNodeInputOptions('CheckpointLoaderSimple', 'ckpt_name'); }

/** Get all LoRAs ComfyUI knows about */
export function getLoras() { return getNodeInputOptions('LoraLoader', 'lora_name'); }

/** Get all LoRAs (model-only variant) */
export function getLorasModelOnly() { return getNodeInputOptions('LoraLoaderModelOnly', 'lora_name'); }

/** Get all CLIP/text encoder models */
export function getClipModels() { return getNodeInputOptions('CLIPLoader', 'clip_name'); }

/** Get all VAE models */
export function getVaeModels() { return getNodeInputOptions('VAELoader', 'vae_name'); }

/** Get upscale models (RealESRGAN etc) from upscale_models folder */
export function getUpscaleModels() { return getNodeInputOptions('UpscaleModelLoader', 'model_name'); }

export function getUnetModels() { return getNodeInputOptions('UNETLoader', 'unet_name'); }

/** Get latent upscale models from latent_upscale_models folder */
export function getLatentUpscaleModels() { return getNodeInputOptions('LatentUpscaleModelLoader', 'model_name'); }

/** Get LTX Audio VAE models — queries the actual node, falls back to checkpoints */
export async function getLtxAudioVaeModels() {
  try { return await getNodeInputOptions('LTXVAudioVAELoader', 'ckpt_name'); }
  catch { return await getCheckpoints(); }
}

/**
 * Free ComfyUI VRAM — unload models from GPU to RAM.
 */
/**
 * Force ComfyUI to refresh its cached file lists for a node type.
 * Calling /object_info/NodeType forces re-evaluation of INPUT_TYPES.
 */
export async function refreshNodeCache(nodeType = 'LoadLatent') {
  try {
    await fetch(`${BASE}/object_info/${nodeType}`);
    return true;
  } catch { return false; }
}

export async function freeVram() {
  try {
    await fetch(`${BASE}/free`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ unload_models: true }),
    });
    return true;
  } catch { return false; }
}

/**
 * Free ComfyUI VRAM + RAM — fully unload everything.
 */
export async function freeAll() {
  try {
    await fetch(`${BASE}/free`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ unload_models: true, free_memory: true }),
    });
    return true;
  } catch { return false; }
}

