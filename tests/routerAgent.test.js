// Unit tests for src/lib/agents/routerAgent.js — specifically the
// parseResponse helper, which is the gate that decides whether the image
// agent fires. The VLM output is noisy (thinking tags, extra prose), so
// this function needs to stay robust.

import { describe, it, expect, beforeAll, vi } from 'vitest';

// The router's `routeMessage` path touches a bunch of stores that subscribe
// to window.electronAPI. We only import `parseResponse`, but the module
// itself imports those stores at top-level, so the stub is needed.
beforeAll(() => {
  globalThis.window = globalThis.window || {};
  // Silence the `[Router] Cleaned:` log so test output stays readable.
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

const { parseResponse } = await import('../src/lib/agents/routerAgent.js');

describe('parseResponse', () => {
  it('returns useTool:false on null/undefined/empty input', () => {
    expect(parseResponse(null)).toEqual({ useTool: false });
    expect(parseResponse(undefined)).toEqual({ useTool: false });
    expect(parseResponse('')).toEqual({ useTool: false });
  });

  it('returns useTool:false when response is exactly "NO"', () => {
    expect(parseResponse('NO')).toEqual({ useTool: false });
    expect(parseResponse('no')).toEqual({ useTool: false });
    expect(parseResponse('No')).toEqual({ useTool: false });
  });

  it('returns useTool:false when response starts with "no"', () => {
    // The current contract: "no" as a prefix counts as a decline, even if
    // there's trailing text. This matches the intent of the router prompt
    // (which tells the VLM to reply with ONLY the word NO).
    expect(parseResponse('no thanks')).toEqual({ useTool: false });
    expect(parseResponse('No tool needed')).toEqual({ useTool: false });
  });

  it('maps "1" to the first tool (generate_image)', () => {
    expect(parseResponse('1')).toEqual({ useTool: true, tool: 'generate_image' });
  });

  it('extracts the tool number from surrounding prose', () => {
    // Defensive — the VLM occasionally adds prose despite the "only a number" rule.
    expect(parseResponse('Tool 1')).toEqual({ useTool: true, tool: 'generate_image' });
    expect(parseResponse('I would use 1.')).toEqual({ useTool: true, tool: 'generate_image' });
  });

  it('returns useTool:false when the number is out of range', () => {
    // Only `generate_image` is registered today, so tool #2 does not exist.
    expect(parseResponse('2')).toEqual({ useTool: false });
    expect(parseResponse('99')).toEqual({ useTool: false });
    // Zero is also out of range (1-indexed registry).
    expect(parseResponse('0')).toEqual({ useTool: false });
  });

  it('strips standard thinking tags before parsing', () => {
    expect(parseResponse('<think>Let me consider the intent.</think>1')).toEqual({
      useTool: true, tool: 'generate_image',
    });
    expect(parseResponse('<thinking>reasoning here</thinking>\nNO')).toEqual({ useTool: false });
    expect(parseResponse('<reasoning>...</reasoning>1')).toEqual({ useTool: true, tool: 'generate_image' });
    expect(parseResponse('<thought>...</thought>NO')).toEqual({ useTool: false });
  });

  it('strips multi-line thinking tags', () => {
    const resp = '<think>\nThe user wants an image.\nI should route to generate_image.\n</think>\n1';
    expect(parseResponse(resp)).toEqual({ useTool: true, tool: 'generate_image' });
  });

  it('strips Gemma-style <|channel>thought ... <channel|> tags', () => {
    const resp = '<|channel>thought\nthe user wants an image<channel|>1';
    expect(parseResponse(resp)).toEqual({ useTool: true, tool: 'generate_image' });
  });

  it('returns useTool:false when the cleaned response has no number and no "no"', () => {
    expect(parseResponse('maybe?')).toEqual({ useTool: false });
    expect(parseResponse('   ')).toEqual({ useTool: false });
  });
});
