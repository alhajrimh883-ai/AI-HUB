/**
 * Chat Pipeline
 *
 * Orchestrates a single Chat turn: load VLM → auto-compact if context is
 * ≥95% → route (auto or manual) → run the chat VLM (image or text) → if a
 * tool was selected, run its agent.
 *
 * Extracted from ChatPage.jsx handleSend during the April 2026 Chat
 * stabilization pass, mirroring the earlier directorPipeline extraction.
 * The caller owns input state, message insertion, generating flag, and the
 * setTimeout for clearing the pipeline-status banner. runChatTurn owns
 * everything else and throws on failure so the caller can decide what to do
 * with the visible error.
 */

import useChatStore, { SYSTEM_PROMPT } from './chatStore';
import * as vlm from './vlmClient';
import { freeVram } from './comfyui';
import { generateImage } from './agents/imageAgent';
import { routeMessage, directTool } from './agents/routerAgent';

/**
 * @param {object} opts
 * @param {object} opts.userMsg           { role:'user', content, images:[{name,base64}] }
 * @param {string|null} opts.activeTool   null = auto-route; 'generate_image' = forced
 * @param {object} opts.vlmCfg            { enabled, modelPath, mmprojPath, ctx }
 * @param {string} opts.pythonPath        path to python executable
 * @param {function} opts.addLog          (label, data) => void
 * @param {function} opts.setPipelineStatus (msg|null) => void
 * @param {function=} opts.onAssistantReply  fired with the final assistant
 *                                           text once the turn is fully done
 *                                           (after any tool agent). ChatPage
 *                                           uses this for auto-speak TTS
 *                                           without coupling the pipeline to
 *                                           the voice feature.
 */
export async function runChatTurn({ userMsg, activeTool, vlmCfg, pythonPath, addLog, setPipelineStatus, onAssistantReply }) {
  const cs = useChatStore.getState();

  // ── Ensure VLM loaded ──
  setPipelineStatus('Loading VLM...');
  let vlmReady = false;
  try {
    const status = await vlm.getVlmStatus();
    addLog('VLM STATUS', status);
    const wantModel = vlmCfg.modelPath?.split(/[/\\]/).pop();
    if (status.state === 'loaded' && status.model === wantModel) {
      vlmReady = true;
      addLog('VLM', 'Already loaded — skipping');
      setPipelineStatus('VLM ready');
    } else if (status.state === 'parked' && status.model === wantModel) {
      addLog('VLM', 'Parked — waking up');
      setPipelineStatus('Waking up VLM...');
      await vlm.loadModel({ model_path: vlmCfg.modelPath, mmproj_path: vlmCfg.mmprojPath, ctx: vlmCfg.ctx, afterInference: 'keep' });
      vlmReady = true;
    }
  } catch (e) { addLog('VLM STATUS ERROR', e.message); }
  if (!vlmReady) {
    addLog('VLM', 'Not ready — full setup');
    setPipelineStatus('Starting VLM server...');
    await vlm.ensureVlmServer(pythonPath || 'python');
    setPipelineStatus('Freeing VRAM...');
    await freeVram().catch(() => {});
    setPipelineStatus('Loading VLM model...');
    await vlm.loadModel({ model_path: vlmCfg.modelPath, mmproj_path: vlmCfg.mmprojPath, ctx: vlmCfg.ctx, afterInference: 'keep' });
    addLog('VLM', 'Loaded successfully');
  }

  // ── Auto-compact ──
  const ctxPct = cs.getContextPercent();
  if (ctxPct >= 95) {
    addLog('COMPACT', `Context at ${ctxPct}% — compacting`);
    setPipelineStatus('Compacting context...');
    const compact = cs.buildCompactPrompt();
    if (compact) {
      const summary = await vlm.infer({
        user_prompt: compact.prompt,
        system_prompt: 'Summarize concisely. Preserve key facts.',
        max_tokens: 1024,
      });
      addLog('COMPACT RESULT', summary);
      cs.applyCompaction(summary, compact.toKeep);
    }
  }

  // ── Route ──
  let route = { useTool: false };
  if (activeTool) {
    route = directTool(activeTool);
    addLog('ROUTE', `Manual toggle → ${activeTool}`);
    setPipelineStatus(`Tool: ${activeTool} (manual)`);
  } else if (!userMsg.images.length) {
    setPipelineStatus('Router: checking intent...');
    addLog('ROUTER', 'Sending to router agent...');
    try {
      route = await routeMessage(userMsg.content, addLog);
      addLog('ROUTER RESULT', route);
      setPipelineStatus(route.useTool ? `Router → tool: ${route.tool}` : 'Router → normal chat');
    } catch (routeErr) {
      addLog('ROUTER ERROR', routeErr.message);
      setPipelineStatus('Router failed → normal chat');
    }
  } else {
    addLog('ROUTE', 'Image attached — skipping router, going to chat');
  }

  // ── Chat VLM ──
  setPipelineStatus(route.useTool ? 'AI responding (tool queued)...' : 'AI responding...');
  const contextMsgs = cs.getContextMessages();
  const hasImage = userMsg.images.length > 0;
  let response;

  if (hasImage) {
    const history = contextMsgs.slice(0, -2).map(m => {
      const prefix = m.role === 'user' ? 'User' : m.role === 'assistant' ? 'Assistant' : m.role === 'summary' ? 'Context' : 'System';
      return `${prefix}: ${m.content}`;
    }).join('\n');
    const sysPrompt = SYSTEM_PROMPT + (history ? `\n\nConversation:\n${history}` : '');
    addLog('CHAT VLM SEND (image)', `system_prompt: ${sysPrompt}\n\nuser_prompt: ${userMsg.content || 'Describe what you see.'}`);
    response = await vlm.infer({
      image_base64: userMsg.images[0].base64,
      user_prompt: userMsg.content || 'Describe what you see.',
      system_prompt: sysPrompt,
      max_tokens: 2048,
    });
  } else {
    const chatMsgs = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...contextMsgs.slice(0, -1).map(m => ({
        role: m.role === 'summary' ? 'system' : m.role,
        content: m.content,
      })),
    ];
    addLog('CHAT VLM SEND', chatMsgs);
    response = await vlm.chatInfer(chatMsgs, 2048);
  }

  addLog('CHAT VLM RESPONSE', response);
  cs.updateLastAssistant(response);

  // ── Tool agent ──
  addLog('TOOL CHECK', `useTool=${route.useTool}, tool=${route.tool}`);
  let finalReply = response;
  if (route.useTool && route.tool === 'generate_image') {
    // runImageAgent overwrites the last assistant message with a summary like
    // "🎨 Generated with <preset>" — that's what we want the voice to speak,
    // not the pre-agent VLM response (which is usually just a teaser).
    finalReply = await runImageAgent({ userMsg, aiReply: response, addLog, setPipelineStatus });
  } else {
    setPipelineStatus(null);
  }

  // ── Post-reply hook (TTS) ──
  try {
    if (onAssistantReply && finalReply) await onAssistantReply(finalReply);
  } catch (speakErr) {
    addLog('TTS ERROR', speakErr.message);
  }
}

/**
 * Image-generation tool agent. Pre-adds a progress message, streams status
 * into it, attaches the generated images, and handles its own errors so a
 * generation failure doesn't wipe the assistant's text reply above.
 */
async function runImageAgent({ userMsg, aiReply, addLog, setPipelineStatus }) {
  const cs = useChatStore.getState();
  addLog('IMAGE AGENT', 'Starting...');
  setPipelineStatus('🎨 Image Agent starting...');
  cs.addMessage({ role: 'assistant', content: '🎨 Starting generation...', images: [], generatedImages: [] });

  // The value we hand back to the TTS hook. Defaults to the original VLM reply
  // so auto-speak sounds natural; falls through to the summary if aiReply was
  // empty and to an error string if the whole thing blew up.
  let spokenLine = aiReply || '';

  try {
    addLog('IMAGE AGENT INPUT', `prompt: "${userMsg.content}"\naiReply: "${aiReply}"`);
    const result = await generateImage({
      prompt: userMsg.content,
      aiReply,
      mode: 'fast',
      resolution: 'square',
      onStatus: (msg) => {
        addLog('IMAGE AGENT STATUS', msg);
        setPipelineStatus(`🎨 ${msg}`);
        cs.updateLastAssistant(`🎨 ${msg}`);
      },
      onProgress: () => {},
    });

    addLog('IMAGE AGENT RESULT', {
      images: result.images?.length, preset: result.preset,
      loras: result.loras, prompt: result.prompt, seed: result.seed,
    });
    setPipelineStatus(`🎨 Done! ${result.preset}`);
    const summary = `🎨 Generated with ${result.preset}${result.loras.length ? ` + ${result.loras.join(', ')}` : ''}`;
    cs.updateLastAssistant(summary);
    if (!spokenLine) spokenLine = summary;

    // Attach the generated images to the last assistant message so the UI
    // can render them. We reach into the store directly because there's no
    // dedicated action for this (one-off mutation).
    const store = useChatStore.getState();
    const activeSession = store.getActiveSession();
    if (activeSession) {
      const msgs = [...activeSession.messages];
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].role === 'assistant') {
          msgs[i] = { ...msgs[i], generatedImages: result.images };
          break;
        }
      }
      useChatStore.setState(s => ({
        sessions: s.sessions.map(se => se.id === s.activeSessionId ? { ...se, messages: msgs } : se),
      }));
    }
  } catch (agentErr) {
    addLog('IMAGE AGENT ERROR', agentErr.message + '\n' + agentErr.stack);
    setPipelineStatus(`🎨 Failed: ${agentErr.message}`);
    cs.updateLastAssistant(`🎨 Generation failed: ${agentErr.message}`);
    spokenLine = `Image generation failed: ${agentErr.message}`;
  }
  return spokenLine;
}
