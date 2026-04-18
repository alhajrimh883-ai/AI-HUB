// Unit tests for src/lib/chatPipeline.js — specifically the new
// `onAssistantReply` hook wired up for the voice feature.
//
// We mock every external dep (VLM, ComfyUI, router, image agent) so the test
// stays hermetic and can run in ~milliseconds. The test exists because
// silently dropping onAssistantReply would break auto-speak without any
// visible error in the UI.

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

// ── Mock everything chatPipeline imports ─────────────────────────────────
// vlmClient: report "already loaded" so the setup branch short-circuits.
vi.mock('../src/lib/vlmClient.js', () => ({
  getVlmStatus: vi.fn(async () => ({ state: 'loaded', model: 'test.gguf' })),
  chatInfer: vi.fn(async () => 'assistant text reply'),
  infer: vi.fn(async () => 'image-branch reply'),
  ensureVlmServer: vi.fn(async () => {}),
  loadModel: vi.fn(async () => {}),
}));
vi.mock('../src/lib/comfyui.js', () => ({
  freeVram: vi.fn(async () => {}),
  freeAll: vi.fn(async () => {}),
}));
// Router: no tool by default. Individual tests override via mockResolvedValueOnce.
vi.mock('../src/lib/agents/routerAgent.js', () => ({
  routeMessage: vi.fn(async () => ({ useTool: false })),
  directTool: vi.fn((tool) => ({ useTool: true, tool })),
}));
vi.mock('../src/lib/agents/imageAgent.js', () => ({
  generateImage: vi.fn(async () => ({
    images: [{ url: 'fake.png' }],
    preset: 'fastPreset',
    loras: ['LoraA'],
    prompt: 'a cat',
    seed: 42,
  })),
}));

beforeAll(() => { globalThis.window = globalThis.window || {}; });

// chatStore touches window but has no electronAPI requirement for these tests.
const { default: useChatStore } = await import('../src/lib/chatStore.js');
const { runChatTurn } = await import('../src/lib/chatPipeline.js');
const routerAgent = await import('../src/lib/agents/routerAgent.js');

beforeEach(() => {
  useChatStore.setState({ sessions: [], activeSessionId: null, isGenerating: false, error: null, maxContext: 8192 });
  useChatStore.getState().newSession('test');
  // Seed the user + empty assistant messages that ChatPage normally inserts
  // before calling runChatTurn.
  useChatStore.getState().addMessage({ role: 'user', content: 'hi there', images: [] });
  useChatStore.getState().addMessage({ role: 'assistant', content: '', images: [] });
  vi.clearAllMocks();
});

const vlmCfg = { enabled: true, modelPath: 'test.gguf', mmprojPath: '', ctx: 4096 };
const addLog = () => {};
const setPipelineStatus = () => {};

describe('runChatTurn onAssistantReply', () => {
  it('fires with the VLM reply when no tool is selected', async () => {
    const onAssistantReply = vi.fn();
    await runChatTurn({
      userMsg: { role: 'user', content: 'hi there', images: [] },
      activeTool: null, vlmCfg, pythonPath: 'python',
      addLog, setPipelineStatus, onAssistantReply,
    });
    expect(onAssistantReply).toHaveBeenCalledTimes(1);
    expect(onAssistantReply).toHaveBeenCalledWith('assistant text reply');
  });

  it('fires with the original VLM reply (not the tool summary) after generate_image', async () => {
    const onAssistantReply = vi.fn();
    await runChatTurn({
      userMsg: { role: 'user', content: 'draw a cat', images: [] },
      activeTool: 'generate_image', vlmCfg, pythonPath: 'python',
      addLog, setPipelineStatus, onAssistantReply,
    });
    expect(onAssistantReply).toHaveBeenCalledTimes(1);
    // runImageAgent returns the aiReply string (natural-sounding) rather than
    // the "🎨 Generated with …" summary — that's the design decision that
    // makes auto-speak sound conversational instead of tool-ish.
    expect(onAssistantReply).toHaveBeenCalledWith('assistant text reply');
  });

  it('uses the image-branch VLM output when the user attaches an image', async () => {
    const onAssistantReply = vi.fn();
    await runChatTurn({
      userMsg: { role: 'user', content: 'what is this?', images: [{ name: 'x.png', base64: 'abc' }] },
      activeTool: null, vlmCfg, pythonPath: 'python',
      addLog, setPipelineStatus, onAssistantReply,
    });
    expect(onAssistantReply).toHaveBeenCalledWith('image-branch reply');
  });

  it('is a no-op when the caller omits onAssistantReply', async () => {
    // This test would throw if runChatTurn blindly called onAssistantReply().
    await expect(runChatTurn({
      userMsg: { role: 'user', content: 'hi', images: [] },
      activeTool: null, vlmCfg, pythonPath: 'python',
      addLog, setPipelineStatus,
    })).resolves.toBeUndefined();
  });

  it('swallows onAssistantReply errors so TTS failures never break the chat turn', async () => {
    const badHook = vi.fn(() => { throw new Error('piper exploded'); });
    await expect(runChatTurn({
      userMsg: { role: 'user', content: 'hi', images: [] },
      activeTool: null, vlmCfg, pythonPath: 'python',
      addLog, setPipelineStatus, onAssistantReply: badHook,
    })).resolves.toBeUndefined();
    expect(badHook).toHaveBeenCalled();
  });

  it('still fires when the router throws (falls back to normal chat)', async () => {
    routerAgent.routeMessage.mockRejectedValueOnce(new Error('router down'));
    const onAssistantReply = vi.fn();
    await runChatTurn({
      userMsg: { role: 'user', content: 'hello', images: [] },
      activeTool: null, vlmCfg, pythonPath: 'python',
      addLog, setPipelineStatus, onAssistantReply,
    });
    expect(onAssistantReply).toHaveBeenCalledWith('assistant text reply');
  });
});
