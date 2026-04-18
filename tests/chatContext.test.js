// Unit tests for src/lib/pipeline/chatContext.js — the chat-history helper
// that the Director uses to feed multi-turn VLM conversation, with image
// stripping and context-budget trimming.

import { describe, it, expect, vi } from 'vitest';
import { createChatContext } from '../src/lib/pipeline/chatContext.js';

describe('chatContext', () => {
  it('exposes messages as the raw mutable array', () => {
    const { messages } = createChatContext();
    expect(Array.isArray(messages)).toBe(true);
    messages.push({ role: 'user', content: 'hello' });
    expect(messages.length).toBe(1);
  });

  it('buildImageContent produces image-blocks then the text block', () => {
    const { buildImageContent } = createChatContext();
    const out = buildImageContent(['aaa', 'bbb'], 'describe');
    expect(out).toHaveLength(3);
    expect(out[0].type).toBe('image_url');
    expect(out[0].image_url.url).toBe('data:image/jpeg;base64,aaa');
    expect(out[2]).toEqual({ type: 'text', text: 'describe' });
  });

  it('stripOldImages replaces image-arrays with a summary string', () => {
    const ctx = createChatContext();
    ctx.messages.push({
      role: 'user',
      content: ctx.buildImageContent(['aaa', 'bbb'], 'prompt'),
    });
    ctx.messages.push({ role: 'assistant', content: 'ok' });
    ctx.stripOldImages();
    expect(typeof ctx.messages[0].content).toBe('string');
    expect(ctx.messages[0].content).toContain('[2 frames were shown]');
    expect(ctx.messages[0].content).toContain('prompt');
    expect(ctx.messages[0]._strippedImages).toBe(2);
    // Assistant message untouched
    expect(ctx.messages[1].content).toBe('ok');
  });

  it('stripOldImages is a no-op on string-content messages', () => {
    const ctx = createChatContext();
    ctx.messages.push({ role: 'user', content: 'no images here' });
    ctx.stripOldImages();
    expect(ctx.messages[0].content).toBe('no images here');
    expect(ctx.messages[0]._strippedImages).toBeUndefined();
  });

  it('calcTokens counts text + image budget', () => {
    const ctx = createChatContext({ imgTokens: 100 });
    // "hi there!" = 9 chars / 3.5 ≈ 3 tokens (rounded)
    ctx.messages.push({ role: 'user', content: 'hi there!' });
    ctx.messages.push({
      role: 'user',
      content: ctx.buildImageContent(['x'], 'ok'),
    });
    // 3 (text) + 100 (1 image) + ~1 (for "ok") = ~104
    const t = ctx.calcTokens();
    expect(t).toBeGreaterThan(100);
    expect(t).toBeLessThan(110);
  });

  it('calcTokens adds extraFrames * imgTokens', () => {
    const ctx = createChatContext({ imgTokens: 50 });
    const base = ctx.calcTokens(0);
    const withExtras = ctx.calcTokens(3);
    expect(withExtras - base).toBe(150);
  });

  it('trim evicts oldest user+assistant pairs until under budget', () => {
    const addLog = vi.fn();
    const onStatus = vi.fn();
    // ctxLimit 2000, responseBuffer 1500 → real budget 500 tokens
    const ctx = createChatContext({ ctxLimit: 2000, imgTokens: 100, addLog, onStatus });
    // Push 6 heavy messages (3 pairs). Each "assistant" text is 350 chars → ~100 tokens.
    const heavy = 'x'.repeat(350);
    for (let i = 0; i < 3; i++) {
      ctx.messages.push({ role: 'user', content: `user-${i}-${heavy}` });
      ctx.messages.push({ role: 'assistant', content: `asst-${i}-${heavy}` });
    }
    expect(ctx.messages.length).toBe(6);
    ctx.trim(0);
    // Should have dropped at least one pair
    expect(ctx.messages.length).toBeLessThan(6);
    expect(addLog).toHaveBeenCalled();
    expect(onStatus).toHaveBeenCalled();
  });

  it('trim stops after 20 attempts even if still over budget', () => {
    const ctx = createChatContext({ ctxLimit: 10, imgTokens: 0 });
    // One giant string — impossible to trim under since it's just one message.
    ctx.messages.push({ role: 'user', content: 'y'.repeat(10000) });
    // No pair to remove — trim should return 0 without looping forever.
    const attempts = ctx.trim(0);
    expect(attempts).toBe(0);
    expect(ctx.messages.length).toBe(1);
  });
});
