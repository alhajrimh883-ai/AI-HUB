/**
 * Image Generation Agent
 * Standalone agent that generates images via ComfyUI.
 * Used by Chat and Director — never touches conversation history.
 *
 * Flow:
 *   1. Smart select preset + LoRAs (VLM in separate context)
 *   2. Park VLM → free VRAM for ComfyUI
 *   3. Build workflow (auto-detects family: sdxl, qwen_t2i, etc.)
 *   4. Queue to ComfyUI, capture result via WebSocket
 *   5. Return image info
 */

import * as comfy from '../comfyui';
import * as vlm from '../vlmClient';
import usePresetStore from '../presetStore';
import useStore from '../store';
import { smartSelect } from '../smartSelect';
import { buildT2I, buildQwenT2I, T2I, QWEN_T2I, STUDIO_RESOLUTIONS, QWEN_RESOLUTIONS } from '../studioWorkflow';

/**
 * Create a VLM infer function for smart select (separate context).
 * Returns null if VLM is not configured.
 */
function createSmartInfer() {
  const ps = usePresetStore.getState();
  const vs = useStore.getState();
  const vlmCfg = ps.getVlmConfig();
  if (!vlmCfg.enabled) return null;

  return async (userPrompt, systemPrompt) => {
    await vlm.ensureVlmServer(vs.pythonPath || 'python');
    // Check if already loaded
    try {
      const status = await vlm.getVlmStatus();
      const wantModel = vlmCfg.modelPath?.split(/[/\\]/).pop();
      if (status.state === 'loaded' && status.model === wantModel) {
        // Already loaded — infer directly
      } else if (status.state === 'parked' && status.model === wantModel) {
        await vlm.loadModel({ model_path: vlmCfg.modelPath, mmproj_path: vlmCfg.mmprojPath, ctx: vlmCfg.ctx, afterInference: 'keep' });
      } else {
        await vlm.loadModel({ model_path: vlmCfg.modelPath, mmproj_path: vlmCfg.mmprojPath, ctx: vlmCfg.ctx, afterInference: 'keep' });
      }
    } catch {
      await vlm.loadModel({ model_path: vlmCfg.modelPath, mmproj_path: vlmCfg.mmprojPath, ctx: vlmCfg.ctx, afterInference: 'keep' });
    }
    return vlm.infer({ user_prompt: userPrompt, system_prompt: systemPrompt, max_tokens: 512 });
  };
}

/**
 * Convert pool LoRA format → workflow LoRA format.
 */
function poolLorasToWorkflow(poolLoras) {
  const result = [];
  for (const l of poolLoras) {
    if (l.isDual) {
      if (l.high?.file) result.push({ name: l.high.file, strength: l.high.strength ?? 1 });
      if (l.low?.file) result.push({ name: l.low.file, strength: l.low.strength ?? 1 });
    } else if (l.single?.file) {
      result.push({ name: l.single.file, strength: l.single.strength ?? 1 });
    }
  }
  return result;
}

/**
 * Queue workflow and capture images via WebSocket.
 * Standalone — no UI dependencies.
 */
function queueAndCapture(workflow, targetNodeId, onProgress) {
  return new Promise(async (resolve, reject) => {
    const captured = [];
    const tracker = comfy.createSmartProgress(workflow);
    const ws = comfy.connectWebSocket({
      onProgress: ({ value, max }) => {
        const p = tracker.onProgress(value, max);
        onProgress?.(p);
      },
      onExecuting: (nid) => {
        if (nid !== null) {
          const p = tracker.onExecuting(nid);
          onProgress?.(p);
        }
      },
      onExecuted: (nodeId, output) => {
        tracker.onExecuted(nodeId);
        if (nodeId === targetNodeId && output?.images) {
          for (const img of output.images) {
            captured.push({ filename: img.filename, subfolder: img.subfolder || '', type: img.type || 'temp' });
          }
        }
      },
      onComplete: () => { ws.close(); resolve(captured); },
      onError: (err) => { ws.close(); reject(new Error(err?.message || 'Generation failed')); },
    });
    try { await comfy.queuePrompt(workflow); } catch (err) { ws.close(); reject(err); }
  });
}

/**
 * Generate an image.
 *
 * @param {string} opts.prompt — original user prompt
 * @param {string} opts.aiReply — Chat VLM's conversational reply (used as enhanced context)
 * @param {string} opts.mode — 'fast' | 'quality' (default: 'fast')
 * @param {string} opts.resolution — 'portrait' | 'square' | 'landscape' (default: 'square')
 * @param {Function} opts.onStatus — status callback
 * @param {Function} opts.onProgress — progress callback (0-1)
 * @returns {{ images, prompt, preset, family, loras, reasoning, seed, resolution }}
 */
export async function generateImage({ prompt, aiReply, mode = 'fast', resolution = 'square', onStatus, onProgress }) {
  if (!prompt?.trim()) throw new Error('No prompt provided');

  const ps = usePresetStore.getState();
  const vs = useStore.getState();

  // The Chat VLM already understood and enhanced the user's intent.
  // Use AI reply as generation prompt context, fall back to user prompt.
  const genPrompt = aiReply?.trim() || prompt;

  // ── Phase 1: Smart select preset + LoRAs ──
  onStatus?.('Choosing preset...');
  const smartInfer = createSmartInfer();

  const result = await smartSelect({
    prompt: genPrompt, type: 't2i', mode,
    presets: ps.presets, loraPresets: ps.loraPresets,
    infer: smartInfer,
  });

  if (!result?.preset) throw new Error('No T2I preset available. Create one in Presets tab.');

  const preset = ps.resolvePreset(result.preset, mode);
  const smartLoras = poolLorasToWorkflow(result.loras || []);
  const allLoras = [...(preset.loras || []), ...smartLoras];

  onStatus?.(`Using: ${preset.name}${result.loras?.length ? ` + ${result.loras.length} LoRA${result.loras.length > 1 ? 's' : ''}` : ''}`);

  // ── Phase 2: Park VLM, prepare for ComfyUI ──
  onStatus?.('Preparing...');
  await vlm.parkVlmIfLoaded();

  // ── Phase 3: Build workflow ──
  const family = preset.family || 'sdxl';
  const seed = Math.floor(Math.random() * 2147483647);

  let wf, previewNode;

  if (family === 'qwen_t2i') {
    wf = buildQwenT2I({
      prompt: genPrompt, negPrompt: preset.negPrompt || '',
      resolution, seed,
      steps: preset.settings?.steps, cfg: preset.settings?.cfg, shift: preset.settings?.shift,
      batchSize: 1, loras: allLoras,
      unet: preset.models?.unet || '', clip: preset.models?.clip || '', vae: preset.models?.vae || '',
    });
    previewNode = QWEN_T2I.SAVE;
  } else {
    wf = buildT2I({
      prompt: genPrompt, negPrompt: preset.negPrompt || '',
      resolution, seed,
      steps: preset.settings?.steps, cfg: preset.settings?.cfg,
      batchSize: 1, loras: allLoras,
      checkpoint: preset.models?.checkpoint || '',
    });
    previewNode = T2I.PREVIEW;
  }

  // ── Phase 4: Queue and capture ──
  onStatus?.('Generating...');
  const captured = await queueAndCapture(wf, previewNode, onProgress);

  if (captured.length === 0) throw new Error('No images captured from ComfyUI');

  // Build URLs
  const images = captured.map(img => ({
    filename: img.filename,
    subfolder: img.subfolder,
    url: comfy.getImageUrl(img.filename, img.subfolder, img.type),
  }));

  return {
    images,
    prompt: genPrompt,
    preset: preset.name,
    family,
    loras: (result.loras || []).map(l => l.name),
    reasoning: result.reasoning,
    seed,
    resolution,
  };
}
