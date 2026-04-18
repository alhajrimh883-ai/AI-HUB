// Smoke test — confirms the vitest harness is wired up.
// If this file runs and passes, the test infrastructure works.

import { describe, it, expect } from 'vitest';

describe('test harness', () => {
  it('runs', () => {
    expect(1 + 1).toBe(2);
  });

  it('imports ES modules', async () => {
    const mod = await import('../src/lib/stripThinking.js');
    expect(typeof mod.stripThinking).toBe('function');
  });

  it('stripThinking removes <think> tags', async () => {
    const { stripThinking } = await import('../src/lib/stripThinking.js');
    const input = 'hello <think>internal reasoning</think> world';
    const output = stripThinking(input);
    expect(output).not.toContain('<think>');
    expect(output).not.toContain('internal reasoning');
    expect(output).toContain('hello');
    expect(output).toContain('world');
  });
});
