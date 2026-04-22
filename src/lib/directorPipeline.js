// Director generation pipeline
// Extracted from components/Director/DirectorPage.jsx on April 18, 2026.
// Pure async logic — no React. Receives store instances + websocket ref + logger
// from the caller and drives the entire T2I → I2V → Extend → Body Fix → HireFix
// generation sequence, including planner phase, smart LoRA selection, and
// planner review retries.

import useDirectorStore from './directorStore';
import useStore from './store';
import usePresetStore from './presetStore';
import { validateRequired } from './presetRegistry';
import * as comfy from './comfyui';
import * as vlm from './vlmClient';
import { stripThinking } from './stripThinking';
import { buildI2V, buildExtend } from './sviproWorkflow';
import { planSegments } from './pipeline/planSegments';
import { computeEstimate } from './pipeline/estimator';
import { createChatContext } from './pipeline/chatContext';
import { createComfyTransport } from './pipeline/comfyTransport';

export async function runPipeline(ds, vs, wsRef, addLog) {
  const s = ds;
  const mainStore = useStore.getState();
  const presetStore = usePresetStore.getState();
  const mode = s.videoPreset; // 'fast' or 'quality'

  // Resolve VLM config from preset
  const vlmCfg = presetStore.getVlmConfig();

  // Resolve presets for this mode
  const t2iPreset = presetStore.getSelectedPreset(mode, 't2i');
  const separate = presetStore.separateVideoPresets;
  const videoPreset = separate ? null : presetStore.getSelectedPreset(mode, 'video');
  const i2vPreset = separate ? presetStore.getSelectedPreset(mode, 'videoI2V') : videoPreset;
  const extPreset = separate ? presetStore.getSelectedPreset(mode, 'videoExtend') : videoPreset;

  // Validate required models for video families
  if (i2vPreset) {
    const { valid, missing } = validateRequired(i2vPreset.family, presetStore.getRequiredModels(i2vPreset.family));
    if (!valid) { s.setError(`Missing required models for ${i2vPreset.family}: ${missing.map(m => m.label).join(', ')}. Configure in Presets tab.`); return; }
  }
  if (extPreset) {
    const { valid, missing } = validateRequired(extPreset.family, presetStore.getRequiredModels(extPreset.family));
    if (!valid) { s.setError(`Missing required models for ${extPreset.family}: ${missing.map(m => m.label).join(', ')}. Configure in Presets tab.`); return; }
  }

  s.setPipelineState('running');
  s.setError(null);
  s.clearVlmHistory();
  s.setCurrentEstimate(null);
  const toStr = (v) => {
    const s = typeof v === 'string' ? v : v?.text || v?.content || String(v || '');
    return stripThinking(s);
  };

  // Session ID for latent file isolation
  const sessionId = `dir_${Date.now()}`;
  addLog?.('director', `Session: ${sessionId}`);

  // Get project folder path — chunk nodes save/load directly here
  let projectPath = '';
  try {
    projectPath = await window.electronAPI.directorGetProjectPath(sessionId);
    addLog?.('director', `Project folder: ${projectPath}`);
  } catch (e) {
    addLog?.('director', `Project folder error: ${e.message}`);
  }

  // Timing helper — wraps an async operation and records duration
  const timed = async (type, fn) => {
    const start = Date.now();
    const result = await fn();
    const seconds = (Date.now() - start) / 1000;
    s.recordTiming(type, seconds);
    addLog?.('director', `Timing: ${type} took ${seconds.toFixed(1)}s`);
    return result;
  };

  // Estimate calculator — reads averages from the store, defers the math to
  // the pure `computeEstimate` helper, then writes the result back.
  const updateEstimate = (completedIndex /* totalSegments read from store */) => {
    const st = useDirectorStore.getState();
    const estimate = computeEstimate({
      segments: st.segments,
      completedIndex,
      avgVlm: st.getAvgTime('vlm'),
      avgImage: st.getAvgTime('image'),
      avgI2v: st.getAvgTime('i2v'),
      avgExtend: st.getAvgTime('extend'),
      useBodyFix: st.useBodyFix,
      avgBodyfix: st.useBodyFix ? st.getAvgTime('bodyfix') : null,
      useHireFix: st.useHireFix,
      avgHirefix: st.useHireFix ? st.getAvgTime('hirefix') : null,
    });
    s.setCurrentEstimate(estimate);
  };

  // Helper: log VLM interaction
  const logVlm = (role, phase, text) => {
    s.addVlmHistory({ role, phase, text: typeof text === 'string' ? text : JSON.stringify(text) });
  };

  // ComfyUI transport: queueWorkflow + reuploadImage + reuploadVideo
  const { queueWorkflow, reuploadImage, reuploadVideo } = createComfyTransport({
    wsRef,
    setPipelineStatus: (st) => s.setPipelineStatus(st),
    addLog,
  });

  try {
    const hasImage = !!s.inputImage;
    const hasVideo = !!s.inputVideo;

    // Build segment plan (extracted to pipeline/planSegments.js for testability)
    const plan = planSegments({
      hasImage, hasVideo,
      hasT2IPreset: !!t2iPreset,
      targetLength: s.targetLength,
      segmentDuration: s.segmentDuration,
      resetEnabled: s.resetEnabled,
      resetInterval: s.resetInterval,
    });
    if (plan.error) {
      s.setError(plan.error);
      s.setPipelineState('idle');
      return;
    }
    const segments = plan.segments;
    s.setSegments(segments);

    let lastImageName = hasImage ? s.inputImage.name : null;
    let originalImageName = lastImageName; // preserved for reset — never overwritten
    let lastVideoName = hasVideo ? s.inputVideo.name : null;
    let lastPrompt = '';
    let isExternalVideo = hasVideo;

    // If we have video but no image, extract first frame as original reference (for resets)
    if (!originalImageName && lastVideoName) {
      try {
        addLog?.('director', 'No start image — extracting first frame from video as reset reference');
        const vidUrl = comfy.getVideoUrl(lastVideoName, '', 'input');
        const extracted = await vlm.extractVideoFrames(vidUrl, 1, () => {});
        if (extracted.frames?.[0]) {
          // Convert base64 to file and upload to ComfyUI input/
          const blob = await fetch(`data:image/jpeg;base64,${extracted.frames[0]}`).then(r => r.blob());
          const file = new File([blob], `${sessionId}_original.png`, { type: 'image/png' });
          const uploaded = await comfy.uploadImage(file);
          originalImageName = uploaded.name;
          addLog?.('director', `✓ Original reference frame: ${originalImageName}`);
        }
      } catch (e) {
        addLog?.('director', `⚠ Could not extract reference frame: ${e.message}`);
      }
    }

    // ── Chat-based conversation history (extracted to pipeline/chatContext.js) ──
    // `messages` is the raw mutable array; factory gives us the token-budget helpers.
    const frameCount = s.directorFrameCount || 8;
    const chatCtx = createChatContext({
      ctxLimit: vlmCfg.ctx || 16384,
      imgTokens: vlmCfg.imageTokens || 1024,
      addLog,
      onStatus: (st) => s.setPipelineStatus(st),
    });
    const chatMessages = chatCtx.messages;
    const buildImageContent = chatCtx.buildImageContent;
    const stripOldImages = chatCtx.stripOldImages;
    const calcChatTokens = chatCtx.calcTokens;
    const trimChat = chatCtx.trim;

    // ── PLANNER PHASE (optional) ──
    if (s.usePlanner) {
      s.setPipelineStatus('Planner creating segment plan...');
      await comfy.freeVram();
      const planTpl = s.fillTemplate(s.templatePlan, { totalSegs: segments.length });
      logVlm('app', 'planner', planTpl);
      const planResult = toStr(await vlm.runVlmPipeline({
        modelPath: vlmCfg.modelPath, mmprojPath: vlmCfg.mmprojPath,
        ctx: vlmCfg.ctx, imageTokens: vlmCfg.imageTokens,
        afterInference: 'keep',
        onStatus: (st) => s.setPipelineStatus(st),
        pythonPath: vs.pythonPath || 'python',
        imageBase64: '', userPrompt: planTpl, systemPrompt: '',
      }));
      logVlm('vlm', 'planner', planResult);

      // Parse plan lines → one per segment
      const planLines = planResult.split('\n')
        .map(l => l.replace(/^\d+[.\x29:\-]\s*/, '').trim())
        .filter(l => l.length > 10);
      const planSegs = segments.map((seg, idx) => ({
        description: planLines[idx] || `Segment ${idx + 1}: continue the scene`,
        approved: false,
      }));
      s.setPlannerSegments(planSegs);
      s.setPlannerVisible(true);
      addLog?.('director', `Planner created ${planSegs.length} segment descriptions`);

      // Inject plan as first message in Director chat
      const planSummary = planSegs.map((p, idx) => `Seg ${idx + 1}: ${p.description}`).join('\n');
      chatMessages.push({ role: 'user', content: `[DIRECTOR PLAN]\n${planSummary}\n\nFollow this plan for each segment. I will tell you which segment to work on.` });
      chatMessages.push({ role: 'assistant', content: 'Understood. I will follow the plan and write prompts for each segment as directed.' });
    }

    // ── Planner review helper ──
    const plannerReview = async (segIdx, frames) => {
      if (!s.usePlanner) return 'APPROVED';
      const plan = useDirectorStore.getState().plannerSegments[segIdx];
      if (!plan) return 'APPROVED';

      s.setPipelineStatus('Planner reviewing output...');
      await comfy.freeVram();
      const reviewTpl = s.fillTemplate(s.templatePlanReview, { planDescription: plan.description });
      logVlm('app', `planner-review-${segIdx}`, `[${frames.length} frames]\n${reviewTpl}`);

      let reviewResult;
      if (frames.length > 0) {
        // Load VLM for image review
        await vlm.ensureVlmServer(vs.pythonPath || 'python', (st) => s.setPipelineStatus(st));
        const status = await vlm.getVlmStatus().catch(() => ({ state: 'unloaded' }));
        if (status.state === 'unloaded' || status.state === 'parked') {
          await vlm.loadModel({ model_path: vlmCfg.modelPath, mmproj_path: vlmCfg.mmprojPath, ctx: vlmCfg.ctx, image_tokens: vlmCfg.imageTokens, gpu_layers: -1 });
        }
        reviewResult = toStr(await vlm.infer({ images_base64: frames, user_prompt: reviewTpl, max_tokens: 512 }));
      } else {
        reviewResult = toStr(await vlm.runVlmPipeline({
          modelPath: vlmCfg.modelPath, mmprojPath: vlmCfg.mmprojPath,
          ctx: vlmCfg.ctx, imageTokens: vlmCfg.imageTokens,
          afterInference: 'keep',
          onStatus: (st) => s.setPipelineStatus(st),
          pythonPath: vs.pythonPath || 'python',
          imageBase64: '', userPrompt: reviewTpl, systemPrompt: '',
        }));
      }
      logVlm('vlm', `planner-review-${segIdx}`, reviewResult);
      return reviewResult.trim();
    };

    // ── SMART LORA SELECTION (optional) ──
    let selectedImageLoras = [];  // [{file, strength}] for T2I
    let selectedVideoLorasHigh = [];  // [{file, strength}] for extend high model — global only
    let selectedVideoLorasLow = [];   // [{file, strength}] for extend low model — global only
    let perSegVideoPresets = [];  // per-segment presets — scanned before each segment

    if (s.useSmartLora && s.loraPresets.length > 0) {
      // Filter presets relevant to current engine
      const relevantPresets = s.loraPresets.filter(p => {
        if (p.target === 'image') return true;
        if (p.target === 'video' && (p.engine === s.videoEngine || p.engine === 'any')) return true;
        return false;
      });
      const globalPresets = relevantPresets.filter(p => p.scope !== 'per-segment');
      perSegVideoPresets = relevantPresets.filter(p => p.scope === 'per-segment' && p.target === 'video');

      if (globalPresets.length > 0) {
        s.setPipelineStatus(`Smart LoRA: scanning ${globalPresets.length} global presets...`);
        await comfy.freeVram();
        const selectedIds = [];

        for (let pi = 0; pi < globalPresets.length; pi++) {
          const preset = globalPresets[pi];
          s.setPipelineStatus(`Smart LoRA: checking "${preset.name}" (${pi + 1}/${globalPresets.length})...`);

          const tpl = s.fillTemplate(s.templateLoraSelect, {
            loraName: preset.name,
            loraDescription: preset.description || 'No description',
            loraTags: (preset.tags || []).join(', ') || 'none',
            loraTarget: `${preset.target} ${preset.engine !== 'any' ? `(${preset.engine})` : ''}`,
          });
          logVlm('app', `lora-scan-${preset.name}`, tpl);

          const answer = toStr(await vlm.runVlmPipeline({
            modelPath: vlmCfg.modelPath, mmprojPath: vlmCfg.mmprojPath,
            ctx: vlmCfg.ctx, imageTokens: vlmCfg.imageTokens,
            afterInference: 'keep',
            onStatus: (st) => s.setPipelineStatus(st),
            pythonPath: vs.pythonPath || 'python',
            imageBase64: '', userPrompt: tpl, systemPrompt: '',
          }));
          logVlm('vlm', `lora-scan-${preset.name}`, answer);

          if (answer.trim().toUpperCase().startsWith('YES')) {
            selectedIds.push(preset.id);
            addLog?.('director', `Smart LoRA (global): selected "${preset.name}"`);
            if (preset.target === 'image') {
              if (preset.loraHigh?.file) selectedImageLoras.push({ name: preset.loraHigh.file, strength: preset.loraHigh.strength || 1.0, strength_model: preset.loraHigh.strength || 1.0, enabled: true });
            } else {
              if (preset.loraHigh?.file) selectedVideoLorasHigh.push({ name: preset.loraHigh.file, strength: preset.loraHigh.strength || 1.0, strength_model: preset.loraHigh.strength || 1.0, enabled: true });
              if (preset.loraLow?.file) selectedVideoLorasLow.push({ name: preset.loraLow.file, strength: preset.loraLow.strength || 1.0, strength_model: preset.loraLow.strength || 1.0, enabled: true });
            }
          } else {
            addLog?.('director', `Smart LoRA (global): skipped "${preset.name}"`);
          }
        }
        s.setSelectedLoraIds(selectedIds);
        s.setPipelineStatus(`Smart LoRA: ${selectedIds.length} global + ${perSegVideoPresets.length} per-segment presets`);
      }
      addLog?.('director', `Smart LoRA: ${selectedImageLoras.length} image, ${selectedVideoLorasHigh.length} video global, ${perSegVideoPresets.length} per-segment`);
    }

    // Helper: scan per-segment LoRAs for a specific segment
    const scanPerSegmentLoras = async (segIndex, segDescription) => {
      if (!s.useSmartLora || perSegVideoPresets.length === 0) return { high: [], low: [] };
      const high = [];
      const low = [];

      for (const preset of perSegVideoPresets) {
        s.setPipelineStatus(`LoRA check: "${preset.name}" for segment ${segIndex + 1}...`);
        const tpl = `User wants: ${s.userIntent}
This is segment ${segIndex + 1}: ${segDescription}

LoRA preset: "${preset.name}"
Description: ${preset.description || 'No description'}
Tags: ${(preset.tags || []).join(', ') || 'none'}
Type: ${preset.target} motion/effect LoRA

Should this LoRA be applied to THIS specific segment? Consider if the motion, effect, or style matches what this particular segment needs.

Respond with EXACTLY one word: YES or NO`;
        logVlm('app', `lora-perseg-${preset.name}-seg${segIndex}`, tpl);

        const answer = toStr(await vlm.runVlmPipeline({
          modelPath: vlmCfg.modelPath, mmprojPath: vlmCfg.mmprojPath,
          ctx: vlmCfg.ctx, imageTokens: vlmCfg.imageTokens,
          afterInference: 'keep',
          onStatus: (st) => s.setPipelineStatus(st),
          pythonPath: vs.pythonPath || 'python',
          imageBase64: '', userPrompt: tpl, systemPrompt: '',
        }));
        logVlm('vlm', `lora-perseg-${preset.name}-seg${segIndex}`, answer);

        if (answer.trim().toUpperCase().startsWith('YES')) {
          addLog?.('director', `Per-seg LoRA: "${preset.name}" → seg ${segIndex + 1}`);
          if (preset.loraHigh?.file) high.push({ name: preset.loraHigh.file, strength: preset.loraHigh.strength || 1.0, strength_model: preset.loraHigh.strength || 1.0, enabled: true });
          if (preset.loraLow?.file) low.push({ name: preset.loraLow.file, strength: preset.loraLow.strength || 1.0, strength_model: preset.loraLow.strength || 1.0, enabled: true });
        }
      }
      return { high, low };
    };

    // Helper: park VLM + free ComfyUI VRAM before generation
    const prepareForComfyUI = async () => {
      try { await vlm.parkModel(); } catch {}
      await comfy.freeVram();
    };

    // Push project files to ComfyUI input/ for extend, return filenames for workflow
    const pushProjectFiles = async () => {
      const result = { latentName: null, videoName: null };
      if (!hasProjectFiles) {
        addLog?.('director', 'No project files yet — skipping push');
        return result;
      }
      try {
        // Push LATENT to ComfyUI input/
        const pushed = await window.electronAPI.directorPushLatent({ sessionId, targetName: `${sessionId}.latent` });
        if (pushed.ok) {
          result.latentName = pushed.latentName;
          addLog?.('director', `✓ Latent → input/${pushed.latentName} (${pushed.size} bytes)`);
        } else { addLog?.('director', `✗ Latent push failed: ${pushed.error}`); }

        // Push VIDEO to ComfyUI input/
        const pushedVid = await window.electronAPI.directorPushVideo({ sessionId, targetName: `${sessionId}.mp4` });
        if (pushedVid.ok) {
          result.videoName = pushedVid.videoName;
          addLog?.('director', `✓ Video → input/${pushedVid.videoName} (${pushedVid.size} bytes)`);
        } else { addLog?.('director', `✗ Video push failed: ${pushedVid.error}`); }

        // Refresh so LoadLatent and VHS_LoadVideo can find the files
        await comfy.refreshNodeCache('LoadLatent');
        addLog?.('director', `Extend files ready: latent=${result.latentName}, video=${result.videoName}`);
      } catch (e) { addLog?.('director', `Push error: ${e.message}`); }
      return result;
    };

    let hasProjectFiles = false; // set true after first video segment completes
    let clipIndex = 0; // incremented for each video clip saved

    for (let i = 0; i < segments.length; i++) {
      // Check for pause/stop
      const state = useDirectorStore.getState().pipelineState;
      if (state === 'idle') return; // stopped
      while (useDirectorStore.getState().pipelineState === 'paused') {
        await new Promise(r => setTimeout(r, 500));
      }
      if (useDirectorStore.getState().pipelineState === 'idle') return;

      const seg = segments[i];
      s.setCurrentSegmentIndex(i);
      s.updateSegment(i, { status: 'active' });

      // ── Generate prompt via VLM ──
      let prompt = '';
      s.setPipelinePhase(seg.type);
      const vlmOpts = {
        modelPath: vlmCfg.modelPath, mmprojPath: vlmCfg.mmprojPath,
        ctx: vlmCfg.ctx, imageTokens: vlmCfg.imageTokens,
        afterInference: 'keep',
        onStatus: (st) => s.setPipelineStatus(st),
        pythonPath: vs.pythonPath || 'python',
      };

      // Get image base64 helper
      const getImageB64 = async (name) => {
        if (!name) return '';
        const url = comfy.getImageUrl(name, '', 'input');
        const resp = await fetch(url); const blob = await resp.blob();
        return new Promise(r => { const rd = new FileReader(); rd.onload = () => r(rd.result.split(',')[1]); rd.readAsDataURL(blob); });
      };

      // Planner injection — prepend segment description to prompts
      const planDesc = s.usePlanner ? (useDirectorStore.getState().plannerSegments[i]?.description || '') : '';
      const planFeedback = seg._plannerFeedback || '';
      const planPrefix = planDesc
        ? `[PLANNER DIRECTION: ${planDesc}]${planFeedback ? `\n[RETRY — Planner feedback: ${planFeedback}]` : ''}\n\n`
        : '';

      if (seg.type === 'image') {
        s.setPipelineStatus('VLM writing image prompt...');
        await comfy.freeVram();
        const tpl = planPrefix + s.fillTemplate(s.templateImage, { segNum: i + 1, totalSegs: segments.length });
        logVlm('app', 'image-prompt', tpl);
        prompt = await timed('vlm', () => vlm.runVlmPipeline({ ...vlmOpts, imageBase64: '', userPrompt: tpl, systemPrompt: '' }).then(toStr));
        logVlm('vlm', 'image-prompt', prompt);
        // Add to chat history for extend context
        chatMessages.push({ role: 'user', content: `[T2I prompt request]\n${tpl}` });
        chatMessages.push({ role: 'assistant', content: prompt });
      } else if (seg.type === 'i2v') {
        s.setPipelineStatus('VLM writing video prompt...');
        await comfy.freeVram();
        const imgB64 = await getImageB64(lastImageName);
        const tpl = planPrefix + s.fillTemplate(s.templateI2V, { segNum: i + 1, totalSegs: segments.length });
        logVlm('app', 'i2v-prompt', tpl);
        prompt = await timed('vlm', () => vlm.runVlmPipeline({ ...vlmOpts, imageBase64: imgB64, userPrompt: tpl, systemPrompt: '' }).then(toStr));
        logVlm('vlm', 'i2v-prompt', prompt);
        // Add to chat history (image already consumed, store as text)
        chatMessages.push({ role: 'user', content: `[1 image was shown]\n${tpl}` });
        chatMessages.push({ role: 'assistant', content: prompt });
      } else if (seg.type === 'reset') {
        // Reset: fresh I2V from original image to break degradation chain
        // VLM sees original first image + current end frame → writes bridging prompt
        s.setPipelineStatus('Reset: VLM writing bridging prompt...');
        await comfy.freeVram();

        // Get original first image (the one used for the very first I2V)
        const origImgName = originalImageName;
        const origB64 = originalImageName ? await getImageB64(originalImageName) : '';

        // Get current end frame from video
        let endFrameB64 = '';
        if (lastVideoName) {
          try {
            const vidUrl = comfy.getVideoUrl(lastVideoName, '', 'input');
            const extracted = await vlm.extractVideoFrames(vidUrl, 1, () => {});
            endFrameB64 = extracted.lastFrame || '';
          } catch (e) { addLog?.('director', `Reset frame extraction: ${e.message}`); }
        }

        // Build reset prompt — VLM sees original + current end frame, writes return transition
        const resetTpl = planPrefix + `Look at the first image (the original scene) and the second image (where the video currently is). Write a video generation prompt that transitions from the current state back toward the original scene. Describe the motion and camera movement that would naturally return to the original composition. Keep it under 100 words.`;
        const resetContent = [];
        if (origB64) resetContent.push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${origB64}` } });
        if (endFrameB64) resetContent.push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${endFrameB64}` } });
        resetContent.push({ type: 'text', text: resetTpl });

        logVlm('app', `reset-${i}`, `[reset: original + end frame]\n${resetTpl}`);

        await vlm.ensureVlmServer(vs.pythonPath || 'python', (st) => s.setPipelineStatus(st));
        const status = await vlm.getVlmStatus().catch(() => ({ state: 'unloaded' }));
        if (status.state === 'unloaded' || status.state === 'parked') {
          s.setPipelineStatus('Loading VLM...');
          await vlm.loadModel({ model_path: vlmCfg.modelPath, mmproj_path: vlmCfg.mmprojPath, ctx: vlmCfg.ctx, image_tokens: vlmCfg.imageTokens, gpu_layers: -1 });
        }

        prompt = await timed('vlm', () => vlm.chatInfer([{ role: 'user', content: resetContent }], 2048).then(toStr));
        logVlm('vlm', `reset-${i}`, prompt);

      } else if (seg.type === 'extend') {
        s.setPipelineStatus(`Extracting ${frameCount} frames from video...`);
        await comfy.freeVram();

        // Extract multiple frames
        let frames = [];
        if (lastVideoName) {
          const vidUrl = comfy.getVideoUrl(lastVideoName, '', 'input');
          try {
            const extracted = await vlm.extractVideoFrames(vidUrl, frameCount, (st) => s.setPipelineStatus(st));
            frames = [...(extracted.frames || []), extracted.lastFrame].filter(Boolean);
          } catch (e) { addLog?.('director', `Frame extraction: ${e.message}`); }
        }

        // Strip images from ALL previous user messages (keep text)
        stripOldImages();

        // Check context budget, trim oldest pairs if needed
        trimChat(frames.length);

        // Build the extend prompt (no {promptHistory} needed — it's in the chat history)
        const tpl = planPrefix + s.fillTemplate(s.templateExtend, { lastPrompt, promptHistory: '', segNum: i + 1, totalSegs: segments.length });

        // Ensure VLM loaded
        await vlm.ensureVlmServer(vs.pythonPath || 'python', (st) => s.setPipelineStatus(st));
        const status = await vlm.getVlmStatus().catch(() => ({ state: 'unloaded' }));
        if (status.state === 'unloaded' || status.state === 'parked') {
          s.setPipelineStatus('Loading VLM model...');
          await vlm.loadModel({ model_path: vlmCfg.modelPath, mmproj_path: vlmCfg.mmprojPath, ctx: vlmCfg.ctx, image_tokens: vlmCfg.imageTokens, gpu_layers: -1 });
        }

        // Add new user message with live frames
        const userMsg = { role: 'user', content: frames.length > 0 ? buildImageContent(frames, tpl) : tpl };
        chatMessages.push(userMsg);

        const chatTokens = calcChatTokens(0);
        s.setPipelineStatus(`VLM: ${frames.length} frames + ${Math.floor(chatMessages.length / 2)} turns of history (~${chatTokens} tokens)...`);
        logVlm('app', `extend-${i}`, `[${frames.length} frames, ${chatMessages.length} messages, ~${chatTokens} tokens]\n${tpl}`);

        // Chat inference with full history
        prompt = await timed('vlm', () => vlm.chatInfer(chatMessages, 2048).then(toStr));

        // Add assistant response to history
        chatMessages.push({ role: 'assistant', content: prompt });

        logVlm('vlm', `extend-${i}`, prompt);
      }

      s.updateSegment(i, { prompt });
      s.setCurrentPrompt(prompt);
      lastPrompt = prompt;

      // Auto-approve or wait
      if (!useDirectorStore.getState().autoApprove) {
        s.setAwaitingApproval(true);
        s.setPipelineStatus(`Review prompt for ${seg.type}...`);
        while (useDirectorStore.getState().awaitingApproval) { await new Promise(r => setTimeout(r, 300)); }
        prompt = useDirectorStore.getState().currentPrompt;
        s.updateSegment(i, { prompt });
        lastPrompt = prompt;
      }

      // ── Run ComfyUI ──
      // Snapshot state before generation — restore on planner rejection
      const snapshotImageName = lastImageName;
      const snapshotVideoName = lastVideoName;
      const snapshotHasProjectFiles = hasProjectFiles;
      s.setPipelineStatus(`Generating ${seg.type}...`);
      let wf;

      if (seg.type === 'image') {
        if (!t2iPreset) { addLog?.('director', 'No T2I preset — skipping image generation'); continue; }
        const { buildT2I } = await import('./studioWorkflow');
        const t2iLoras = [...(t2iPreset.loras || []), ...selectedImageLoras];
        wf = buildT2I({ prompt, negPrompt: '', seed: 0, resolution: s.resolution, checkpoint: t2iPreset.models?.checkpoint || '', loras: t2iLoras });
      } else if (seg.type === 'i2v') {
        if (!i2vPreset) { s.setError('No I2V video preset selected for ' + mode + ' mode. Configure in Presets tab.'); return; }
        // Split preset loras: dual → separate HIGH/LOW with own strengths, single → both
        const i2vH = [], i2vL = [];
        for (const l of (i2vPreset.loras || [])) {
          if (l.nameHigh || l.nameLow) {
            if (l.nameHigh) i2vH.push({ name: l.nameHigh, strength: l.strengthHigh ?? 1 });
            if (l.nameLow) i2vL.push({ name: l.nameLow, strength: l.strengthLow ?? 1 });
          } else if (l.name) {
            i2vH.push({ name: l.name, strength: l.strength ?? 1 });
            i2vL.push({ name: l.name, strength: l.strength ?? 1 });
          }
        }
        wf = buildI2V({
          imageName: lastImageName, userPrompt: prompt,
          latentPrefix: `latents/${sessionId}`, videoPrefix: `video/${sessionId}`,
          qualityPreset: mode, resolution: s.resolution, highRes: s.highRes,
          ckptHigh: i2vPreset.models?.ckptHigh, ckptLow: i2vPreset.models?.ckptLow,
          clipModel: i2vPreset.models?.clip, vaeModel: i2vPreset.models?.vae,
          settings: i2vPreset.settings,
          videoDuration: s.segmentDuration, fps: 16,
          lorasHigh: i2vH, lorasLow: i2vL,
        });
        addLog?.('director', `I2V: resolution=${s.resolution}, HD=${s.highRes}, mode=${mode}`);
      } else if (seg.type === 'reset') {
        // SVI PRO FLF Reset: same extend workflow but with end_samples → original image
        if (!extPreset) { s.setError('No Extend video preset selected for ' + mode + ' mode. Configure in Presets tab.'); return; }
        addLog?.('director', `Reset at segment ${i + 1}: SVI PRO FLF returning to original frame`);

        const pushed = await pushProjectFiles();

        // LoRAs (same as normal extend)
        const reqModels = presetStore.getRequiredModels(extPreset.family);
        const resetHighLoras = [], resetLowLoras = [];
        for (const l of (extPreset.loras || [])) {
          if (l.nameHigh || l.nameLow) {
            if (l.nameHigh) resetHighLoras.push({ name: l.nameHigh, strength: l.strengthHigh ?? 1 });
            if (l.nameLow) resetLowLoras.push({ name: l.nameLow, strength: l.strengthLow ?? 1 });
          } else if (l.name) {
            resetHighLoras.push({ name: l.name, strength: l.strength ?? 1 });
            resetLowLoras.push({ name: l.name, strength: l.strength ?? 1 });
          }
        }

        wf = buildExtend({
          userPrompt: prompt,
          projectPath, fileName: sessionId,
          latentPrefix: `latents/${sessionId}`, videoPrefix: `video/${sessionId}`,
          latentName: pushed.latentName, videoName: pushed.videoName,
          useEndSamples: true,
          qualityPreset: mode, settings: extPreset.settings,
          ckptHigh: extPreset.models?.ckptHigh, ckptLow: extPreset.models?.ckptLow,
          clipModel: extPreset.models?.clip, vaeModel: extPreset.models?.vae,
          sviLoraHigh: reqModels?.sviLoraHigh, sviLoraLow: reqModels?.sviLoraLow,
          videoDuration: s.segmentDuration, fps: 16,
          lorasHigh: resetHighLoras, lorasLow: resetLowLoras,
        });

      } else {
        if (!extPreset) { s.setError('No Extend video preset selected for ' + mode + ' mode. Configure in Presets tab.'); return; }
        const segDesc = (s.usePlanner && useDirectorStore.getState().plannerSegments[i]?.description) || prompt || `Segment ${i + 1}`;
        const perSegLoras = await scanPerSegmentLoras(i, segDesc);

        // Split preset loras: dual → separate HIGH/LOW with own strengths, single → both
        const reqModels = presetStore.getRequiredModels(extPreset.family);
        const extHighLoras = [], extLowLoras = [];
        for (const l of (extPreset.loras || [])) {
          if (l.nameHigh || l.nameLow) {
            if (l.nameHigh) extHighLoras.push({ name: l.nameHigh, strength: l.strengthHigh ?? 1 });
            if (l.nameLow) extLowLoras.push({ name: l.nameLow, strength: l.strengthLow ?? 1 });
          } else if (l.name) {
            extHighLoras.push({ name: l.name, strength: l.strength ?? 1 });
            extLowLoras.push({ name: l.name, strength: l.strength ?? 1 });
          }
        }
        extHighLoras.push(...selectedVideoLorasHigh, ...perSegLoras.high);
        extLowLoras.push(...selectedVideoLorasLow, ...perSegLoras.low);
        if (perSegLoras.high.length > 0) addLog?.('director', `Segment ${i + 1}: +${perSegLoras.high.length} per-segment LoRAs`);

        // Push project video+latent to ComfyUI input/ BEFORE building workflow
        const pushed = await pushProjectFiles();
        addLog?.('director', `Building extend: latent=${pushed.latentName}, video=${pushed.videoName}, pick=${isExternalVideo ? 'end' : 'start'}`);
        wf = buildExtend({
          userPrompt: prompt,
          projectPath, fileName: sessionId,
          latentPrefix: `latents/${sessionId}`, videoPrefix: `video/${sessionId}`,
          latentName: pushed.latentName, videoName: pushed.videoName,
          qualityPreset: mode, settings: extPreset.settings,
          ckptHigh: extPreset.models?.ckptHigh, ckptLow: extPreset.models?.ckptLow,
          clipModel: extPreset.models?.clip, vaeModel: extPreset.models?.vae,
          sviLoraHigh: reqModels?.sviLoraHigh, sviLoraLow: reqModels?.sviLoraLow,
          videoDuration: s.segmentDuration, fps: 16,
          lorasHigh: extHighLoras, lorasLow: extLowLoras,
        });
      }

      await prepareForComfyUI();
      const result = await timed(seg.type, () => queueWorkflow(wf, seg.type));

      // ── Process result ──
      if (result.type === 'image') {
        const re = await reuploadImage(result.data);
        lastImageName = re.name;
        if (!originalImageName) originalImageName = re.name; // capture for resets

        // ── Body Fix (before HireFix) ──
        if (s.useBodyFix && lastImageName) {
          if (!s.bodyFixCheckpoint) throw new Error('Body Fix enabled but no edit model selected in Settings');
          s.setPipelineStatus('VLM analyzing for body issues...');
          await comfy.freeVram();
          const bodyImg = await getImageB64(lastImageName);
          const bodyPrompt = 'Look at this AI-generated image carefully. Describe any anatomical issues: extra fingers, malformed hands, broken limbs, distorted faces, or unnatural body proportions. Write a short editing instruction to fix ONLY the body issues without changing the art style, composition, or concept. If the image looks fine, respond with just "no fix needed". Output ONLY the instruction.';
          logVlm('app', 'body-fix', bodyPrompt);
          const fixInstr = toStr(await vlm.runVlmPipeline({ ...vlmOpts, imageBase64: bodyImg, userPrompt: bodyPrompt, systemPrompt: '' }));
          logVlm('vlm', 'body-fix', fixInstr);

          if (fixInstr && !fixInstr.toLowerCase().includes('no fix needed')) {
            s.setPipelineStatus('Fixing body issues...');
            const { buildEditorOverlay } = await import('./editorWorkflow');
            const fixWf = buildEditorOverlay({ imageName: lastImageName, prompt: fixInstr, resolution: s.resolution, checkpoint: s.bodyFixCheckpoint });
            await prepareForComfyUI();
            const fixResult = await timed('bodyfix', () => queueWorkflow(fixWf, 'body-fix'));
            if (fixResult.type === 'image') {
              const fixRe = await reuploadImage(fixResult.data);
              lastImageName = fixRe.name;
              addLog?.('director', 'Body fix applied');
            }
          } else {
            addLog?.('director', 'Body fix skipped — image looks fine');
          }
        }

        // ── HireFix ──
        if (s.useHireFix && lastImageName) {
          if (!s.hireFixCheckpoint) throw new Error('HireFix enabled but no edit model selected in Settings');
          s.setPipelineStatus('Running HireFix...');
          const { buildHireFix } = await import('./studioWorkflow');
          const hfWf = buildHireFix({ imageName: lastImageName, prompt, negPrompt: '', upscaleBy: s.hireFixUpscaleBy, denoise: s.hireFixDenoise, mode: s.hireFixMode || 'fast', checkpoint: s.hireFixCheckpoint, upscaleModel: s.hireFixUpscaleModel || undefined });
          await prepareForComfyUI();
          const hfResult = await timed('hirefix', () => queueWorkflow(hfWf, 'hirefix'));
          if (hfResult.type === 'image') {
            const hfRe = await reuploadImage(hfResult.data);
            lastImageName = hfRe.name;
            addLog?.('director', 'HireFix applied');
          }
        }

        // Update segment with final image
        s.updateSegment(i, { status: 'done', result: {
          type: 'image', filename: lastImageName, subfolder: '',
          url: comfy.getImageUrl(lastImageName, '', 'input'),
        } });

        // Save start image to project folder
        const savedImg = await window.electronAPI.directorSaveImage({
          sessionId, comfyFilename: lastImageName, comfySubfolder: '', comfyType: 'input',
        });
        if (savedImg.ok) addLog?.('director', `Start image saved to project (${savedImg.size} bytes)`);
        else addLog?.('director', `Image save failed: ${savedImg.error}`);
      } else if (result.type === 'complete') {
        // Fallback: no standard output captured
        addLog?.('director', 'Generation complete (no WebSocket output) — grabbing latent...');

        await new Promise(r => setTimeout(r, 500));
        const grabbed = await window.electronAPI.directorGrabLatent({ sessionId, prefix: sessionId });
        if (grabbed.ok) addLog?.('director', `✓ Latent grabbed: ${grabbed.source}`);
        else addLog?.('director', `✗ Latent grab failed: ${grabbed.error}`);

        hasProjectFiles = true;
        isExternalVideo = false;
        s.updateSegment(i, { status: 'done', result: {
          type: 'video', filename: lastVideoName || sessionId,
          subfolder: '', url: lastVideoName ? comfy.getImageUrl(lastVideoName, '', 'input') + `&t=${Date.now()}` : '',
        } });
      } else {
        // Standard output — SaveVideo reported through WebSocket
        addLog?.('director', `✓ Video captured: ${result.data.filename}`);

        // Grab latent from output/
        await new Promise(r => setTimeout(r, 300));
        const grabbed = await window.electronAPI.directorGrabLatent({ sessionId, prefix: sessionId });
        if (grabbed.ok) addLog?.('director', `✓ Latent grabbed: ${grabbed.source}`);
        else addLog?.('director', `✗ Latent grab failed: ${grabbed.error}`);

        // Save clip to project clips/ folder (each clip encoded once, never re-encoded)
        const clipResult = await window.electronAPI.directorSaveClip({
          sessionId, clipIndex,
          comfyFilename: result.data.filename,
          comfySubfolder: result.data.subfolder || 'video',
          comfyType: result.data.type || 'output',
        });
        if (clipResult.ok) {
          addLog?.('director', `✓ Clip ${clipIndex} saved: ${clipResult.clipName} (${clipResult.size} bytes)`);
          clipIndex++;
        } else {
          addLog?.('director', `✗ Clip save failed: ${clipResult.error}`);
        }

        // Concat all clips → accumulated.mp4 → push to ComfyUI input/
        s.setPipelineStatus('Concatenating clips...');
        const concatResult = await window.electronAPI.directorConcatClips({
          sessionId, targetName: `${sessionId}.mp4`,
        });
        if (concatResult.ok) {
          lastVideoName = concatResult.videoName;
          addLog?.('director', `✓ Accumulated video: ${concatResult.clipCount} clips → ${concatResult.videoName}`);
        } else {
          throw new Error(`Video concat failed: ${concatResult.error}. Ensure ffmpeg is installed (restart app to auto-install).`);
        }

        hasProjectFiles = true;
        isExternalVideo = false;
        s.updateSegment(i, { status: 'done', result: {
          type: 'video', filename: lastVideoName, subfolder: '',
          url: comfy.getImageUrl(lastVideoName, '', 'input') + `&t=${Date.now()}`,
        } });
      }

      addLog?.('director', `${seg.type} complete: ${result.data?.filename}`);

      if (seg.type === 'reset') {
        addLog?.('director', 'Reset complete — continuing with extend from reset output');
      }

      updateEstimate(i, segments.length);

      // Save project metadata after each segment
      try {
        await window.electronAPI.directorSaveProject({ sessionId, metadata: {
          engine: 'wan22',
          intent: s.userIntent, brief: s.storyBrief, resolution: s.resolution,
          videoPreset: s.videoPreset, targetLength: s.targetLength,
          segmentDuration: s.segmentDuration, totalSegments: segments.length,
          completedSegments: i + 1, hasImage: !!lastImageName, hasVideo: !!lastVideoName,
          hasLatent: hasProjectFiles, cameraMode: s.cameraMode, lightingMode: s.lightingMode,
          createdAt: parseInt(sessionId.split('_')[1]) || Date.now(),
          updatedAt: Date.now(),
        }});
      } catch {}

      // ── Planner Review (optional) ──
      if (s.usePlanner) {
        // Get frames from the result for review
        let reviewFrames = [];
        if (result.type === 'image' && lastImageName) {
          const b64 = await getImageB64(lastImageName);
          if (b64) reviewFrames = [b64];
        } else if (result.type === 'video' && lastVideoName) {
          try {
            const vidUrl = comfy.getVideoUrl(lastVideoName, '', 'input');
            const extracted = await vlm.extractVideoFrames(vidUrl, 4, (st) => s.setPipelineStatus(st));
            reviewFrames = [...(extracted.frames || []), extracted.lastFrame].filter(Boolean);
          } catch {}
        }

        const review = await plannerReview(i, reviewFrames);
        logVlm('planner', `review-seg-${i}`, review);

        if (review.toUpperCase().startsWith('APPROVED')) {
          s.updatePlannerSegment(i, { approved: true });
          addLog?.('director', `Planner APPROVED segment ${i + 1}`);
        } else {
          // Rejected — extract feedback
          const feedback = review.replace(/^REJECTED:?\s*/i, '').trim() || 'Output does not match plan';
          const retryCount = seg._retries || 0;

          if (retryCount < (s.plannerMaxRetries || 2)) {
            addLog?.('director', `Planner REJECTED segment ${i + 1} (attempt ${retryCount + 1}): ${feedback}`);
            s.setPipelineStatus(`Planner rejected — retrying: ${feedback}`);

            // Restore to pre-generation state
            lastImageName = snapshotImageName;
            lastVideoName = snapshotVideoName;
            hasProjectFiles = snapshotHasProjectFiles;

            // Strip the rejected attempt from Director chat (last user+assistant pair)
            if (chatMessages.length >= 2) {
              chatMessages.splice(chatMessages.length - 2, 2);
            }

            // Mark retry and re-run this segment
            segments[i] = { ...segments[i], _retries: retryCount + 1, _plannerFeedback: feedback, status: 'pending', prompt: '', result: null };
            s.updateSegment(i, { status: 'active', prompt: '', result: null });
            i--; // will be incremented by loop, so same segment reruns
            continue;
          } else {
            addLog?.('director', `Planner rejected but max retries reached, accepting segment ${i + 1}`);
            s.updatePlannerSegment(i, { approved: true });
          }
        }
      }
    }

    s.setPipelineState('complete');
    s.setPipelineStatus('All segments complete!');
  } catch (err) {
    s.setPipelineState('error');
    s.setError(typeof err === 'string' ? err : err?.message || JSON.stringify(err));
    s.setPipelineStatus(`Error: ${err?.message || err}`);
  }
}
