// Unit tests for src/lib/chatStore.js — sessions, token accounting, and the
// compaction contract that backs the 95% auto-compact trigger in Chat.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';

// The store subscribes to window.electronAPI for persistence. Stub window so
// that the module can be imported cleanly under node.
beforeAll(() => {
  globalThis.window = globalThis.window || {};
});

const { default: useChatStore, SYSTEM_PROMPT } = await import('../src/lib/chatStore.js');

// Reset to a clean baseline before every test.
beforeEach(() => {
  useChatStore.setState({
    sessions: [],
    activeSessionId: null,
    isGenerating: false,
    error: null,
    maxContext: 8192,
    fontSize: 10,
  });
});

const s = () => useChatStore.getState();

describe('session actions', () => {
  it('newSession adds a session and marks it active', () => {
    const id = s().newSession('My Chat');
    expect(s().sessions).toHaveLength(1);
    expect(s().sessions[0].id).toBe(id);
    expect(s().sessions[0].name).toBe('My Chat');
    expect(s().activeSessionId).toBe(id);
  });

  it('newSession defaults name to "New Chat" when not given', () => {
    s().newSession();
    expect(s().sessions[0].name).toBe('New Chat');
  });

  it('deleteSession removes it and falls back to another active session', () => {
    // Pre-populate directly — `newSession` uses Date.now() for ids which can
    // collide inside a sub-millisecond test; we want two guaranteed-distinct ids.
    useChatStore.setState({
      sessions: [
        { id: 'a', name: 'A', messages: [], createdAt: 1, updatedAt: 1 },
        { id: 'b', name: 'B', messages: [], createdAt: 1, updatedAt: 1 },
      ],
      activeSessionId: 'a',
    });
    s().deleteSession('a');
    expect(s().sessions).toHaveLength(1);
    // Falls back to the remaining session (b).
    expect(s().activeSessionId).toBe('b');
  });

  it('deleting the only session clears activeSessionId', () => {
    useChatStore.setState({
      sessions: [{ id: 'a', name: 'A', messages: [], createdAt: 1, updatedAt: 1 }],
      activeSessionId: 'a',
    });
    s().deleteSession('a');
    expect(s().activeSessionId).toBeNull();
    expect(s().sessions).toHaveLength(0);
  });

  it('renameSession updates the name in place', () => {
    useChatStore.setState({
      sessions: [{ id: 'a', name: 'Old', messages: [], createdAt: 1, updatedAt: 1 }],
      activeSessionId: 'a',
    });
    s().renameSession('a', 'New');
    expect(s().sessions[0].name).toBe('New');
  });
});

describe('addMessage / updateLastAssistant', () => {
  beforeEach(() => { s().newSession('t'); });

  it('addMessage pushes onto the active session and stamps id/timestamp', () => {
    s().addMessage({ role: 'user', content: 'hi' });
    const msgs = s().getActiveSession().messages;
    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe('user');
    expect(msgs[0].content).toBe('hi');
    expect(typeof msgs[0].id).toBe('string');
    expect(typeof msgs[0].timestamp).toBe('number');
  });

  it('updateLastAssistant mutates the most recent assistant message only', () => {
    s().addMessage({ role: 'user', content: 'hi' });
    s().addMessage({ role: 'assistant', content: 'initial' });
    s().addMessage({ role: 'user', content: 'more' });
    s().updateLastAssistant('final answer');
    const msgs = s().getActiveSession().messages;
    expect(msgs[1].content).toBe('final answer');
    // Other messages untouched.
    expect(msgs[0].content).toBe('hi');
    expect(msgs[2].content).toBe('more');
  });

  it('updateLastAssistant is a no-op if there is no assistant message', () => {
    s().addMessage({ role: 'user', content: 'hi' });
    s().updateLastAssistant('ignored');
    const msgs = s().getActiveSession().messages;
    expect(msgs[0].content).toBe('hi');
  });
});

describe('token accounting', () => {
  beforeEach(() => { s().newSession('t'); });

  it('getTokenUsage counts the system prompt even for an empty session', () => {
    // ceil(SYSTEM_PROMPT.length / 4)
    const expected = Math.ceil(SYSTEM_PROMPT.length / 4);
    expect(s().getTokenUsage()).toBe(expected);
  });

  it('getTokenUsage adds message-content tokens (4 chars/token)', () => {
    s().addMessage({ role: 'user', content: 'x'.repeat(40) }); // 10 tokens
    const base = Math.ceil(SYSTEM_PROMPT.length / 4);
    expect(s().getTokenUsage()).toBe(base + 10);
  });

  it('getTokenUsage adds 1024 tokens per attached image', () => {
    s().addMessage({ role: 'user', content: '', images: ['aaa', 'bbb'] });
    const base = Math.ceil(SYSTEM_PROMPT.length / 4);
    // 2 images × 1024 + 0 content
    expect(s().getTokenUsage()).toBe(base + 2048);
  });

  it('getContextPercent caps at 100', () => {
    s().setMaxContext(100);
    s().addMessage({ role: 'user', content: 'x'.repeat(10000) });
    expect(s().getContextPercent()).toBe(100);
  });
});

describe('getContextMessages — image stripping', () => {
  beforeEach(() => { s().newSession('t'); });

  it('keeps all images when there are at most 2 image-bearing messages', () => {
    s().addMessage({ role: 'user', content: 'm1', images: ['a'] });
    s().addMessage({ role: 'user', content: 'm2', images: ['b'] });
    const out = s().getContextMessages();
    expect(out[0].images).toEqual(['a']);
    expect(out[1].images).toEqual(['b']);
  });

  it('strips images from older messages once there are more than 2', () => {
    s().addMessage({ role: 'user', content: 'oldest', images: ['a'] });
    s().addMessage({ role: 'user', content: 'middle', images: ['b'] });
    s().addMessage({ role: 'user', content: 'newest', images: ['c'] });
    const out = s().getContextMessages();
    // Only the 2 most recent image-bearing messages keep their images.
    expect(out[2].images).toEqual(['c']);
    expect(out[1].images).toEqual(['b']);
    expect(out[0].images).toEqual([]);
    // Text content is preserved.
    expect(out[0].content).toBe('oldest');
  });

  it('only counts image-bearing messages toward the 2-image cap', () => {
    s().addMessage({ role: 'user', content: 'img1', images: ['a'] });
    s().addMessage({ role: 'assistant', content: 'just text' });
    s().addMessage({ role: 'user', content: 'img2', images: ['b'] });
    s().addMessage({ role: 'user', content: 'img3', images: ['c'] });
    const out = s().getContextMessages();
    // 3 image messages total → the oldest (index 0) is stripped.
    expect(out[0].images).toEqual([]);
    expect(out[2].images).toEqual(['b']);
    expect(out[3].images).toEqual(['c']);
    // Text-only assistant message unchanged.
    expect(out[1].images).toBeUndefined();
  });

  it('returns [] when no session is active', () => {
    useChatStore.setState({ activeSessionId: null });
    expect(s().getContextMessages()).toEqual([]);
  });
});

describe('buildCompactPrompt / applyCompaction', () => {
  beforeEach(() => { s().newSession('t'); });

  const push = (n, role = 'user') => {
    for (let i = 0; i < n; i++) {
      s().addMessage({ role: role === 'alt' ? (i % 2 ? 'assistant' : 'user') : role, content: `msg-${i}` });
    }
  };

  it('returns null when fewer than 6 messages', () => {
    push(5, 'alt');
    expect(s().buildCompactPrompt()).toBeNull();
  });

  it('returns a prompt + toKeep at the 6-message boundary', () => {
    push(6, 'alt');
    const out = s().buildCompactPrompt();
    expect(out).not.toBeNull();
    expect(out.toKeep).toHaveLength(4);
    expect(out.prompt).toContain('Summarize this conversation');
    // First 2 messages show up in the transcript; last 4 do not.
    expect(out.prompt).toContain('msg-0');
    expect(out.prompt).toContain('msg-1');
    expect(out.prompt).not.toContain('msg-5');
  });

  it('annotates image counts in the transcript', () => {
    s().addMessage({ role: 'user', content: 'with-img', images: ['a', 'b'] });
    push(5, 'alt'); // 1 + 5 = 6 total
    const out = s().buildCompactPrompt();
    expect(out.prompt).toContain('[2 image(s)]');
  });

  it('applyCompaction replaces history with summary + toKeep', () => {
    push(6, 'alt');
    const { toKeep } = s().buildCompactPrompt();
    s().applyCompaction('short summary here', toKeep);
    const msgs = s().getActiveSession().messages;
    expect(msgs).toHaveLength(5); // 1 summary + 4 kept
    expect(msgs[0].role).toBe('summary');
    expect(msgs[0].content).toBe('short summary here');
    expect(msgs[1].content).toBe('msg-2');
    expect(msgs[4].content).toBe('msg-5');
  });
});

describe('autoNameSession', () => {
  it('names the session from the first user message, truncated to 40 chars', () => {
    s().newSession();
    s().addMessage({ role: 'user', content: 'Hey can you generate an image of a cat sitting by a window?' });
    s().autoNameSession();
    const name = s().getActiveSession().name;
    expect(name.length).toBeLessThanOrEqual(43); // 40 + "..."
    expect(name.endsWith('...')).toBe(true);
    expect(name.startsWith('Hey can you')).toBe(true);
  });

  it('leaves short names intact (no ellipsis)', () => {
    s().newSession();
    s().addMessage({ role: 'user', content: 'hello' });
    s().autoNameSession();
    expect(s().getActiveSession().name).toBe('hello');
  });

  it('is a no-op once the session has been named manually', () => {
    s().newSession('Custom Name');
    s().addMessage({ role: 'user', content: 'anything' });
    s().autoNameSession();
    expect(s().getActiveSession().name).toBe('Custom Name');
  });
});
