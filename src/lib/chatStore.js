/**
 * Chat Store
 * Session-based chat with VLM. Each session has its own message history.
 * Persisted to disk. Smart context management with image stripping + auto-compact.
 */

import { create } from 'zustand';

// Hardcoded — not editable, not persisted. Avoids stale prompts.
const SYSTEM_PROMPT = `You are a helpful AI assistant running locally. You can see images when they're shared with you. You're knowledgeable about AI art generation, ComfyUI workflows, LoRAs, prompting techniques, and creative direction. Be concise but thorough.

You have access to tools that can generate images and other content. When the user asks you to create, generate, make, or draw something, respond naturally confirming what you'll create for them — the app will handle the actual generation automatically. Describe what you plan to create so the generation tool knows what to make.`;

const estimateTokens = (text) => Math.ceil((text || '').length / 4);
const IMAGE_TOKEN_COST = 1024;

const createSession = (name) => ({
  id: `chat_${Date.now()}`,
  name: name || 'New Chat',
  messages: [],
  createdAt: Date.now(),
  updatedAt: Date.now(),
});

const useChatStore = create((set, get) => ({
  // ── Sessions ──
  sessions: [],
  activeSessionId: null,
  isGenerating: false,
  error: null,
  maxContext: 8192,
  fontSize: 10, // px, user adjustable

  // ── Session Actions ──

  newSession: (name) => {
    const session = createSession(name);
    set(s => ({
      sessions: [session, ...s.sessions],
      activeSessionId: session.id,
      error: null,
    }));
    return session.id;
  },

  setActiveSession: (id) => set({ activeSessionId: id, error: null }),

  deleteSession: (id) => set(s => ({
    sessions: s.sessions.filter(se => se.id !== id),
    activeSessionId: s.activeSessionId === id ? (s.sessions.find(se => se.id !== id)?.id || null) : s.activeSessionId,
  })),

  renameSession: (id, name) => set(s => ({
    sessions: s.sessions.map(se => se.id === id ? { ...se, name } : se),
  })),

  // ── Message Actions (operate on active session) ──

  getActiveSession: () => {
    const s = get();
    return s.sessions.find(se => se.id === s.activeSessionId) || null;
  },

  addMessage: (msg) => set(s => ({
    sessions: s.sessions.map(se => se.id === s.activeSessionId ? {
      ...se, updatedAt: Date.now(),
      messages: [...se.messages, { ...msg, id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, timestamp: Date.now() }],
    } : se),
  })),

  updateLastAssistant: (content) => set(s => ({
    sessions: s.sessions.map(se => {
      if (se.id !== s.activeSessionId) return se;
      const msgs = [...se.messages];
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].role === 'assistant') { msgs[i] = { ...msgs[i], content }; break; }
      }
      return { ...se, messages: msgs, updatedAt: Date.now() };
    }),
  })),

  setGenerating: (v) => set({ isGenerating: v }),
  setError: (v) => set({ error: v }),
  setMaxContext: (v) => set({ maxContext: v }),
  setFontSize: (v) => set({ fontSize: v }),

  // ── Context Management ──

  getTokenUsage: () => {
    const session = get().getActiveSession();
    if (!session) return 0;
    let tokens = estimateTokens(SYSTEM_PROMPT);
    for (const m of session.messages) {
      tokens += estimateTokens(m.content);
      tokens += (m.images?.length || 0) * IMAGE_TOKEN_COST;
    }
    return tokens;
  },

  getContextPercent: () => {
    const s = get();
    return Math.min(100, Math.round((s.getTokenUsage() / s.maxContext) * 100));
  },

  getContextMessages: () => {
    const session = get().getActiveSession();
    if (!session) return [];
    const msgs = [...session.messages];
    let imageCount = 0;
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].images?.length > 0) {
        imageCount++;
        if (imageCount > 2) msgs[i] = { ...msgs[i], images: [] };
      }
    }
    return msgs;
  },

  buildCompactPrompt: () => {
    const session = get().getActiveSession();
    if (!session || session.messages.length < 6) return null;
    const toSummarize = session.messages.slice(0, -4);
    const toKeep = session.messages.slice(-4);
    if (toSummarize.length < 2) return null;
    const transcript = toSummarize.map(m => {
      const prefix = m.role === 'user' ? 'User' : m.role === 'assistant' ? 'Assistant' : 'System';
      const imgNote = m.images?.length ? ` [${m.images.length} image(s)]` : '';
      return `${prefix}: ${m.content}${imgNote}`;
    }).join('\n');
    return {
      prompt: `Summarize this conversation concisely. Preserve: key facts, decisions, technical details, user goals. Remove: pleasantries, redundant exchanges.\n\nConversation:\n${transcript}\n\nConcise summary:`,
      toKeep,
    };
  },

  applyCompaction: (summary, toKeep) => set(s => ({
    sessions: s.sessions.map(se => se.id === s.activeSessionId ? {
      ...se, updatedAt: Date.now(),
      messages: [
        { id: `summary_${Date.now()}`, role: 'summary', content: summary, images: [], timestamp: Date.now() },
        ...toKeep,
      ],
    } : se),
  })),

  // Auto-name session from first user message
  autoNameSession: () => {
    const s = get();
    const session = s.getActiveSession();
    if (!session || session.name !== 'New Chat') return;
    const firstUser = session.messages.find(m => m.role === 'user');
    if (firstUser?.content) {
      const name = firstUser.content.slice(0, 40) + (firstUser.content.length > 40 ? '...' : '');
      set(s2 => ({
        sessions: s2.sessions.map(se => se.id === session.id ? { ...se, name } : se),
      }));
    }
  },

  // ── Persistence ──

  loadPersistedState: (data) => {
    if (data.chatSessions) set({ sessions: data.chatSessions });
    if (data.chatActiveSessionId) set({ activeSessionId: data.chatActiveSessionId });
    if (data.chatFontSize) set({ fontSize: data.chatFontSize });
  },

  getPersistedState: () => {
    const s = get();
    return {
      chatSessions: s.sessions,
      chatActiveSessionId: s.activeSessionId,
      chatFontSize: s.fontSize,
    };
  },
}));

const PERSIST_KEYS = ['sessions', 'activeSessionId', 'fontSize'];
useChatStore.subscribe((state, prev) => {
  const changed = PERSIST_KEYS.some(k => state[k] !== prev[k]);
  if (changed && window.electronAPI?.saveSettings) {
    const current = useChatStore.getState().getPersistedState();
    window.electronAPI.loadSettings?.().then(data => {
      window.electronAPI.saveSettings({ ...data, ...current });
    });
  }
});

export { SYSTEM_PROMPT };
export default useChatStore;
