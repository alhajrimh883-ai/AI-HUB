/**
 * Router Agent
 * ONE VLM call: reads user intent, replies with tool number or NO.
 * The VLM knows it's a router, not a chatbot.
 * App identifies itself — VLM knows the user can't see this.
 */

import * as vlm from '../vlmClient';
import usePresetStore from '../presetStore';
import useStore from '../store';

// ── Tool registry ──
const TOOLS = [
  { id: 'generate_image', label: 'Generate an image from a text description' },
  // Future:
  // { id: 'animate_image', label: 'Animate an image into a video' },
];

// ── Router system prompt — tells VLM exactly what it is ──
function buildSystemPrompt() {
  let prompt = `You are a ROUTER inside an application. You are NOT a chatbot. The user CANNOT see your response.

Your only job: read the user's message and decide if it requires a tool.

Available tools:
`;
  TOOLS.forEach((t, i) => {
    prompt += `${i + 1}. ${t.id} — ${t.label}\n`;
  });
  prompt += `
Rules:
- If the user wants to CREATE, GENERATE, MAKE, or DRAW something → reply with ONLY the tool number
- If the user is asking a question, chatting, or discussing → reply with ONLY: NO
- Your final answer must be a single number or the word NO`;
  return prompt;
}

/**
 * Parse router response — expects a number or "NO".
 * Exported for unit testing; callers should use routeMessage().
 */
export function parseResponse(response) {
  if (!response) return { useTool: false };

  // Strip thinking tags
  let clean = (response || '')
    .replace(/<\|channel>thought[\s\S]*?<channel\|>/gi, '')
    .replace(/<(?:think|thinking|reasoning|thought)>[\s\S]*?<\/(?:think|thinking|reasoning|thought)>/gi, '')
    .trim();

  console.log('[Router] Cleaned:', JSON.stringify(clean));

  // Check for NO first
  if (clean.toLowerCase() === 'no' || clean.toLowerCase().startsWith('no')) {
    return { useTool: false };
  }

  // Try to find a tool number
  const numMatch = clean.match(/\d+/);
  if (numMatch) {
    const idx = parseInt(numMatch[0]) - 1;
    if (idx >= 0 && idx < TOOLS.length) {
      return { useTool: true, tool: TOOLS[idx].id };
    }
  }

  return { useTool: false };
}

/**
 * Route a user message. ONE VLM call.
 * @param {string} userMessage
 * @param {Function} log — optional (label, data) => void for debug panel
 */
export async function routeMessage(userMessage, log) {
  if (!userMessage?.trim()) return { useTool: false };

  const ps = usePresetStore.getState();
  const vs = useStore.getState();
  const vlmCfg = ps.getVlmConfig();
  if (!vlmCfg.enabled) { log?.('ROUTER', 'No VLM enabled — skipping'); return { useTool: false }; }

  try {
    await vlm.ensureVlmServer(vs.pythonPath || 'python');

    try {
      const status = await vlm.getVlmStatus();
      const want = vlmCfg.modelPath?.split(/[/\\]/).pop();
      if (status.state !== 'loaded' || status.model !== want) {
        log?.('ROUTER VLM', 'Loading model...');
        await vlm.loadModel({ model_path: vlmCfg.modelPath, mmproj_path: vlmCfg.mmprojPath, ctx: vlmCfg.ctx, afterInference: 'keep' });
      }
    } catch {
      log?.('ROUTER VLM', 'Loading model (fallback)...');
      await vlm.loadModel({ model_path: vlmCfg.modelPath, mmproj_path: vlmCfg.mmprojPath, ctx: vlmCfg.ctx, afterInference: 'keep' });
    }

    const systemPrompt = buildSystemPrompt();
    const wrappedMessage = `[SYSTEM AUTO-ROUTER — the user cannot see this response]\nThe following is the user's message. Decide if it needs a tool:\n\n"${userMessage}"`;

    log?.('ROUTER SYSTEM PROMPT', systemPrompt);
    log?.('ROUTER USER PROMPT', wrappedMessage);

    const response = await vlm.infer({
      user_prompt: wrappedMessage,
      system_prompt: systemPrompt,
      max_tokens: 2048,
    });

    log?.('ROUTER RAW RESPONSE', response);
    const result = parseResponse(response);
    log?.('ROUTER PARSED', result);
    return result;
  } catch (err) {
    log?.('ROUTER ERROR', err.message);
    return { useTool: false };
  }
}

/** Get tools list for UI */
export function getAvailableTools() {
  return TOOLS.map(t => ({ id: t.id, label: t.label }));
}

/** Directly select a tool (bypass router) */
export function directTool(toolId) {
  const tool = TOOLS.find(t => t.id === toolId);
  if (tool) return { useTool: true, tool: tool.id };
  return { useTool: false };
}
