import React, { useState, useEffect, useRef, useCallback } from 'react';
import useChatStore from '../../lib/chatStore';
import usePresetStore from '../../lib/presetStore';
import useStore from '../../lib/store';
import useVoiceStore from '../../lib/voiceStore';
import { runChatTurn } from '../../lib/chatPipeline';
import { parseThinking, sanitizeForSpeech } from '../../lib/stripThinking';
import { copyToClipboard } from '../../lib/clipboard';
import * as voice from '../../lib/voiceClient';
// Mic recording is server-side (voice_server.py + sounddevice) -- the renderer
// only sends start/stop pings. The old getUserMedia-based useMicRecorder hook
// was crashing the Chromium renderer on some Windows audio drivers.
import ThinkingBlock from './ThinkingBlock';
import {
  Send, Paperclip, Trash2, X, Settings, Copy,
  Loader, MessageSquare, AlertCircle, Plus,
  Image as ImageIcon, RotateCcw, Edit3, Check, Terminal,
  Mic, Volume2, VolumeX, Square,
} from 'lucide-react';

export default function ChatPage() {
  const cs = useChatStore();
  const ps = usePresetStore();
  const vs = useStore();
  const vc = useVoiceStore();
  const [isRecording, setIsRecording] = useState(false);

  const [input, setInput] = useState('');
  const [attachedImages, setAttachedImages] = useState([]);
  const [showSettings, setShowSettings] = useState(false);
  const [activeTool, setActiveTool] = useState(null); // null = auto-detect, 'generate_image' = forced
  const [pipelineStatus, setPipelineStatus] = useState(null); // visible status for user
  const [renamingId, setRenamingId] = useState(null);
  const [renameText, setRenameText] = useState('');
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [debugLog, setDebugLog] = useState([]);
  const [showDebug, setShowDebug] = useState(false);
  const [speakingMsgId, setSpeakingMsgId] = useState(null);  // which message is currently being spoken
  const audioRef = useRef(null);                              // active <audio> element so we can stop it

  const messagesEndRef = useRef(null);
  const debugEndRef = useRef(null);
  const fileInputRef = useRef(null);

  const addLog = useCallback((label, data) => {
    const entry = { time: new Date().toLocaleTimeString(), label, data: typeof data === 'string' ? data : JSON.stringify(data, null, 2) };
    setDebugLog(prev => [...prev, entry]);
    setTimeout(() => debugEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 50);
  }, []);

  // ── Voice helpers ──
  // Stop anything currently playing. Called before we start a new TTS clip and
  // when the user clicks 🔊 on a message that's already speaking.
  const stopSpeaking = useCallback(() => {
    if (audioRef.current) { try { audioRef.current.pause(); } catch {} audioRef.current = null; }
    setSpeakingMsgId(null);
  }, []);

  // Plays `text` via the voice server. Strips thinking tags first — otherwise
  // Piper happily reads "<think>" out loud, which is not the vibe.
  const speakText = useCallback(async (text, msgId) => {
    if (!text || !vc.enabled) return;
    stopSpeaking();
    const { content } = parseThinking(text);
    if (!content.trim()) return;
    // Piper pronounces every "**" and "#" literally ("asterisk asterisk prompt
    // engineering asterisk asterisk"). Strip markdown + emoji before handing
    // the text off. Thinking tags are already gone via parseThinking above.
    const spoken = sanitizeForSpeech(content);
    if (!spoken.trim()) return;
    try {
      addLog('TTS', `speaking ${spoken.length} chars via ${vc.engine} (sanitized from ${content.length})`);
      await voice.ensureVoiceServer({
        pythonPath: vs.pythonPath || 'python',
        engine: vc.engine,
        kokoroVoice: vc.kokoroVoice,
        piperPath: vc.piperPath || undefined,
      });
      // Push the current engine + voice to the server so it matches Settings.
      // Cheap to do on every /speak — no-op if already in sync.
      const cfg = { engine: vc.engine };
      if (vc.engine === 'piper' && vc.piperPath) cfg.piper_path = vc.piperPath;
      if (vc.engine === 'kokoro') cfg.kokoro_voice = vc.kokoroVoice;
      await voice.setVoiceConfig(cfg);
      const { audioBase64 } = await voice.speak(spoken);
      const audio = new Audio('data:audio/wav;base64,' + audioBase64);
      audioRef.current = audio;
      setSpeakingMsgId(msgId || 'live');
      audio.onended = () => { if (audioRef.current === audio) { audioRef.current = null; setSpeakingMsgId(null); } };
      audio.onerror = () => { audioRef.current = null; setSpeakingMsgId(null); };
      await audio.play();
    } catch (e) { addLog('TTS ERROR', e.message); setSpeakingMsgId(null); }
  }, [vc.enabled, vc.engine, vc.kokoroVoice, vc.piperPath, vs.pythonPath, stopSpeaking, addLog]);

  // Push-to-talk with server-side recording. First click: POST /record/start.
  // Second click: POST /record/stop, which captures frames via sounddevice on
  // the Python side, transcribes with Whisper, and returns the text. We
  // prepend the text to the input field and let the user hit Send manually.
  //
  // Nothing here touches getUserMedia / MediaRecorder / the Chromium audio
  // stack -- that was the origin of the earlier blank-screen renderer crash.
  const handleMicClick = useCallback(async () => {
    try {
      if (isRecording) {
        setIsRecording(false);
        setPipelineStatus('Transcribing...');
        try {
          await voice.ensureVoiceServer({ pythonPath: vs.pythonPath || 'python' });
          if (vc.whisperPath) {
            try { await voice.setVoiceConfig({ whisper_path: vc.whisperPath }); }
            catch (cfgErr) { addLog('STT CONFIG WARN', cfgErr.message); }
          }
          const result = await voice.recordStop({});
          if (!result.recorded) { addLog('STT', 'no active recording to stop'); setPipelineStatus(null); return; }
          const text = (result.text || '').trim();
          addLog('STT', `${(result.duration_sec || 0).toFixed(1)}s -> "${text}"`);
          if (text) setInput(prev => (prev ? prev + ' ' : '') + text);
          else setPipelineStatus('No speech detected.');
        } catch (e) {
          addLog('STT ERROR', e.message);
          cs.setError(`Transcription failed: ${e.message}`);
        } finally {
          setTimeout(() => setPipelineStatus(null), 2000);
        }
      } else {
        if (!vc.whisperPath) { cs.setError('Download a Whisper model in Settings first.'); return; }
        // Make sure the voice server is up before we try to record.
        await voice.ensureVoiceServer({ pythonPath: vs.pythonPath || 'python' });
        if (vc.whisperPath) {
          try { await voice.setVoiceConfig({ whisper_path: vc.whisperPath }); }
          catch (cfgErr) { addLog('STT CONFIG WARN', cfgErr.message); }
        }
        addLog('MIC', 'Recording (server-side)...');
        await voice.recordStart();
        setIsRecording(true);
      }
    } catch (e) {
      console.error('[ChatPage] mic handler failed:', e);
      addLog('MIC HANDLER ERROR', e?.message || String(e));
      cs.setError(`Mic error: ${e?.message || e}`);
      setIsRecording(false);
      setPipelineStatus(null);
    }
  }, [isRecording, vc.whisperPath, vs.pythonPath, cs, addLog]);
  // Stop any playback when unmounting (e.g. tab switch) so audio doesn't run loose.
  useEffect(() => () => stopSpeaking(), [stopSpeaking]);

  // Global Escape-to-stop-speaking — a natural reflex when Piper/Kokoro starts
  // reading something you didn't mean to hear. We check speakingMsgId inside
  // the handler instead of in the dep array so the listener stays installed
  // once; re-binding on every state change would be wasteful.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape' && audioRef.current) {
        stopSpeaking();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [stopSpeaking]);

  const vlmCfg = ps.getVlmConfig();
  const isVlmAvailable = vlmCfg.enabled;
  const isBusy = vs.activeGen?.active;
  const session = cs.getActiveSession();

  useEffect(() => { if (vlmCfg.ctx) cs.setMaxContext(vlmCfg.ctx); }, [vlmCfg.ctx]);
  useEffect(() => { messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [session?.messages, cs.isGenerating]);

  // ── Send ──
  // Thin wrapper: owns UI state (input/images/pipeline-status banner) and
  // lifecycle flags (isGenerating). All pipeline logic lives in
  // src/lib/chatPipeline.js → runChatTurn.
  const handleSend = useCallback(async () => {
    if (!input.trim() && attachedImages.length === 0) return;
    if (!isVlmAvailable) return cs.setError('No VLM preset selected.');
    if (cs.isGenerating) return;

    if (!cs.activeSessionId) cs.newSession();

    const userMsg = {
      role: 'user', content: input.trim(),
      images: attachedImages.map(img => ({ name: img.name, base64: img.base64 })),
    };

    cs.addMessage(userMsg);
    cs.addMessage({ role: 'assistant', content: '', images: [] });
    cs.setGenerating(true);
    cs.setError(null);
    setPipelineStatus(null);
    setInput('');
    setAttachedImages([]);
    setTimeout(() => cs.autoNameSession(), 100);

    addLog('USER MESSAGE', userMsg.content);
    if (userMsg.images.length) addLog('ATTACHED IMAGES', `${userMsg.images.length} image(s)`);

    try {
      await runChatTurn({
        userMsg,
        activeTool,
        vlmCfg,
        pythonPath: vs.pythonPath,
        addLog,
        setPipelineStatus,
        onAssistantReply: vc.enabled && vc.autoSpeak ? (reply) => speakText(reply) : undefined,
      });
    } catch (err) {
      addLog('PIPELINE ERROR', err.message + '\n' + err.stack);
      setPipelineStatus(`Error: ${err.message}`);
      cs.updateLastAssistant('');
      cs.setError(err.message);
    } finally {
      cs.setGenerating(false);
      setTimeout(() => setPipelineStatus(null), 3000);
    }
  }, [input, attachedImages, isVlmAvailable, cs, vlmCfg, vs.pythonPath, activeTool, addLog, vc.enabled, vc.autoSpeak, speakText]);

  const handleAttachImage = useCallback((e) => {
    for (const file of Array.from(e.target.files || [])) {
      const reader = new FileReader();
      reader.onload = () => {
        setAttachedImages(prev => [...prev, { name: file.name, base64: reader.result.split(',')[1], preview: reader.result }]);
      };
      reader.readAsDataURL(file);
    }
    e.target.value = '';
  }, []);

  const handlePaste = useCallback((e) => {
    for (const item of (e.clipboardData?.items || [])) {
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        const file = item.getAsFile();
        const reader = new FileReader();
        reader.onload = () => {
          setAttachedImages(prev => [...prev, { name: 'pasted.png', base64: reader.result.split(',')[1], preview: reader.result }]);
        };
        reader.readAsDataURL(file);
      }
    }
  }, []);

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
  };

  const contextPercent = session ? cs.getContextPercent() : 0;

  return (
    <div className="h-full flex">
      {/* ── Session Sidebar ── */}
      {sidebarOpen && (
        <div className="w-52 shrink-0 border-r border-surface-border bg-bg-800/30 flex flex-col">
          <div className="p-2 border-b border-surface-border flex gap-1">
            <button onClick={() => cs.newSession()}
              className="flex-1 btn bg-accent text-white text-[10px] py-1.5 flex items-center justify-center gap-1">
              <Plus size={10} /> New Chat
            </button>
            <button onClick={() => setSidebarOpen(false)}
              className="btn btn-ghost text-neutral-600 hover:text-neutral-400 px-1.5 py-1.5 border border-surface-border">
              <X size={10} />
            </button>
          </div>
        <div className="flex-1 overflow-y-auto p-1.5 space-y-0.5">
          {cs.sessions.length === 0 && (
            <p className="text-[9px] text-neutral-600 text-center py-4">No chats yet</p>
          )}
          {cs.sessions.map(se => (
            <div key={se.id}
              className={`group rounded-lg px-2.5 py-2 cursor-pointer transition-colors ${
                cs.activeSessionId === se.id ? 'bg-accent/10 border border-accent/20' : 'hover:bg-bg-700 border border-transparent'
              }`}
              onClick={() => cs.setActiveSession(se.id)}>
              {renamingId === se.id ? (
                <div className="flex items-center gap-1">
                  <input value={renameText} onChange={e => setRenameText(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') { cs.renameSession(se.id, renameText); setRenamingId(null); } if (e.key === 'Escape') setRenamingId(null); }}
                    autoFocus className="input-field text-[9px] flex-1 py-0.5" onClick={e => e.stopPropagation()} />
                  <button onClick={(e) => { e.stopPropagation(); cs.renameSession(se.id, renameText); setRenamingId(null); }}><Check size={9} className="text-accent" /></button>
                </div>
              ) : (
                <>
                  <p className="text-[10px] text-neutral-300 truncate leading-tight">{se.name}</p>
                  <div className="flex items-center justify-between mt-0.5">
                    <span className="text-[8px] text-neutral-600">{se.messages.length} msgs</span>
                    <div className="flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button onClick={(e) => { e.stopPropagation(); setRenamingId(se.id); setRenameText(se.name); }}
                        className="text-neutral-600 hover:text-accent"><Edit3 size={9} /></button>
                      <button onClick={(e) => { e.stopPropagation(); cs.deleteSession(se.id); }}
                        className="text-neutral-600 hover:text-red-400"><Trash2 size={9} /></button>
                    </div>
                  </div>
                </>
              )}
            </div>
          ))}
        </div>
      </div>
      )}

      {/* ── Chat Area ── */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-2 border-b border-surface-border bg-bg-800 shrink-0">
          <div className="flex items-center gap-2">
            {!sidebarOpen && (
              <button onClick={() => setSidebarOpen(true)}
                className="text-neutral-600 hover:text-neutral-400 mr-1">
                <MessageSquare size={14} />
              </button>
            )}
            {sidebarOpen && <MessageSquare size={14} className="text-accent" />}
            <span className="text-[11px] font-semibold text-neutral-300 truncate">{session?.name || 'Chat'}</span>
            {isVlmAvailable ? (
              <span className="text-[8px] text-emerald-400 bg-emerald-500/10 px-1.5 py-0.5 rounded truncate max-w-32">{vlmCfg.modelPath?.split(/[/\\]/).pop()}</span>
            ) : (
              <span className="text-[8px] text-amber-400 bg-amber-500/10 px-1.5 py-0.5 rounded">No VLM</span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {session && (
              <div className="flex items-center gap-1.5">
                <div className="w-14 h-1.5 bg-bg-700 rounded-full overflow-hidden">
                  <div className={`h-full rounded-full transition-all ${contextPercent > 90 ? 'bg-red-500' : contextPercent > 70 ? 'bg-amber-500' : 'bg-accent'}`}
                    style={{ width: `${contextPercent}%` }} />
                </div>
                <span className="text-[8px] text-neutral-600 font-mono">{contextPercent}%</span>
              </div>
            )}
            <button onClick={() => setShowSettings(!showSettings)}
              className={`p-1.5 rounded transition-colors ${showSettings ? 'bg-accent/10 text-accent' : 'text-neutral-600 hover:text-neutral-400'}`}>
              <Settings size={12} />
            </button>
            <button onClick={() => setShowDebug(!showDebug)}
              className={`p-1.5 rounded transition-colors ${showDebug ? 'bg-amber-500/10 text-amber-400' : 'text-neutral-600 hover:text-neutral-400'}`}
              title="Debug Log">
              <Terminal size={12} />
            </button>
          </div>
        </div>

        {/* Settings Panel */}
        {showSettings && (
          <div className="px-4 py-3 border-b border-surface-border bg-bg-800/50 shrink-0">
            <label className="text-[8px] text-neutral-500 uppercase tracking-wider block mb-1">Font Size</label>
            <div className="flex items-center gap-2">
              <input type="range" min="8" max="16" step="1" value={cs.fontSize}
                onChange={e => cs.setFontSize(parseInt(e.target.value))}
                className="flex-1 accent-accent h-1" />
              <span className="text-[9px] text-neutral-400 font-mono w-8 text-right">{cs.fontSize}px</span>
            </div>
            <p className="text-[8px] text-neutral-600 mt-0.5" style={{ fontSize: cs.fontSize }}>Preview text at {cs.fontSize}px</p>
          </div>
        )}

        {/* Debug Log Panel */}
        {showDebug && (
          <div className="border-b border-amber-500/20 bg-bg-900 shrink-0 flex flex-col" style={{ maxHeight: '40vh' }}>
            <div className="flex items-center justify-between px-3 py-1.5 border-b border-amber-500/10 bg-amber-500/5">
              <span className="text-[8px] text-amber-400 font-bold uppercase tracking-wider">Pipeline Debug Log</span>
              <div className="flex gap-1">
                <span className="text-[7px] text-neutral-600">{debugLog.length} entries</span>
                <button onClick={() => setDebugLog([])} className="text-[7px] text-neutral-600 hover:text-amber-400 px-1">Clear</button>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto p-2 space-y-1 font-mono">
              {debugLog.length === 0 && (
                <p className="text-[8px] text-neutral-700 text-center py-4">Send a message to see the pipeline log</p>
              )}
              {debugLog.map((entry, i) => (
                <div key={i} className="text-[8px] border-b border-bg-700 pb-1">
                  <div className="flex gap-2">
                    <span className="text-neutral-700 shrink-0">{entry.time}</span>
                    <span className="text-amber-400 font-bold shrink-0">{entry.label}</span>
                  </div>
                  <pre className="text-neutral-400 whitespace-pre-wrap break-all mt-0.5 pl-4">{entry.data}</pre>
                </div>
              ))}
              <div ref={debugEndRef} />
            </div>
          </div>
        )}

        {/* Messages */}
        <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3 min-h-0">
          {!session && (
            <div className="flex flex-col items-center justify-center text-center py-16">
              <MessageSquare size={36} className="text-neutral-800 mb-2" />
              <p className="text-[11px] text-neutral-500 mb-1">Chat with your local VLM</p>
              <p className="text-[9px] text-neutral-600">Click "New Chat" to start a conversation.</p>
              {!isVlmAvailable && <p className="text-[9px] text-amber-400 mt-2">Select a VLM preset in the header first.</p>}
            </div>
          )}

          {session?.messages.map(msg => (
            <div key={msg.id} className={`flex gap-2.5 ${msg.role === 'user' ? 'justify-end' : ''}`}>
              {msg.role !== 'user' && (
                <div className={`w-6 h-6 rounded-full shrink-0 flex items-center justify-center text-[9px] mt-0.5 ${
                  msg.role === 'summary' ? 'bg-blue-500/20 text-blue-400' : 'bg-accent/20 text-accent'
                }`}>{msg.role === 'summary' ? '📋' : '🧠'}</div>
              )}
              <div className={`max-w-[70%]`}>
                <div className={`rounded-xl px-3 py-2 ${
                  msg.role === 'user' ? 'bg-accent/15 border border-accent/20' :
                  msg.role === 'summary' ? 'bg-blue-500/5 border border-blue-500/20' :
                  'bg-bg-700 border border-surface-border'
                }`}>
                  {msg.role === 'summary' && <span className="text-[7px] text-blue-400 uppercase tracking-wider font-bold block mb-1">Context Summary</span>}
                  {msg.images?.length > 0 && (
                    <div className="flex gap-1.5 mb-1.5">
                      {msg.images.map((img, i) => (
                        <img key={i} src={`data:image/png;base64,${img.base64}`} className="w-16 h-16 rounded-lg object-cover border border-surface-border" />
                      ))}
                    </div>
                  )}
                  {msg.generatedImages?.length > 0 && (
                    <div className="space-y-1.5 mb-2">
                      {msg.generatedImages.map((img, i) => (
                        <img key={i} src={img.url} className="max-w-xs rounded-lg border border-accent/20 shadow-lg" />
                      ))}
                    </div>
                  )}
                  {msg.content ? (() => {
                    const { thinking, content } = msg.role === 'assistant' ? parseThinking(msg.content) : { thinking: '', content: msg.content };
                    return (
                      <>
                        {thinking && <ThinkingBlock text={thinking} />}
                        <p className="text-neutral-300 leading-relaxed whitespace-pre-wrap" style={{ fontSize: cs.fontSize }}>{content}</p>
                      </>
                    );
                  })() : cs.isGenerating && msg.role === 'assistant' ? (
                    <div className="flex items-center gap-1.5">
                      <Loader size={9} className="animate-spin text-accent" />
                      <span className="text-[9px] text-neutral-500">Thinking...</span>
                    </div>
                  ) : null}
                </div>
                {msg.role === 'assistant' && msg.content && !msg.content.startsWith('⏳') && (() => {
                  const { content } = parseThinking(msg.content);
                  const isSpeaking = speakingMsgId === msg.id;
                  return content && (
                    <div className="flex gap-1 mt-0.5">
                      <button onClick={() => copyToClipboard(content)}
                        className="text-[7px] text-neutral-600 hover:text-neutral-400 flex items-center gap-0.5 px-1 py-0.5 rounded hover:bg-bg-700">
                        <Copy size={7} /> Copy
                      </button>
                      {vc.enabled && (
                        <button onClick={() => isSpeaking ? stopSpeaking() : speakText(content, msg.id)}
                          className={`text-[7px] flex items-center gap-0.5 px-1 py-0.5 rounded hover:bg-bg-700 ${isSpeaking ? 'text-accent' : 'text-neutral-600 hover:text-neutral-400'}`}
                          title={isSpeaking ? 'Stop' : 'Speak'}>
                          <Volume2 size={7} /> {isSpeaking ? 'Stop' : 'Speak'}
                        </button>
                      )}
                    </div>
                  );
                })()}
              </div>
              {msg.role === 'user' && (
                <div className="w-6 h-6 rounded-full shrink-0 flex items-center justify-center text-[9px] bg-accent/10 text-accent mt-0.5">👤</div>
              )}
            </div>
          ))}
          <div ref={messagesEndRef} />
        </div>

        {/* Error */}
        {cs.error && (
          <div className="mx-4 mb-2 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-1.5 flex items-center gap-2 shrink-0">
            <AlertCircle size={9} className="text-red-400 shrink-0" />
            <span className="text-[9px] text-red-300 flex-1">{cs.error}</span>
            <button onClick={() => cs.setError(null)}><X size={8} className="text-red-400" /></button>
          </div>
        )}

        {/* Busy warning */}
        {isBusy && (
          <div className="mx-4 mb-2 bg-amber-500/10 border border-amber-500/30 rounded-lg px-3 py-1 shrink-0">
            <span className="text-[9px] text-amber-400">Generation in progress — VLM responds when free.</span>
          </div>
        )}

        {/* Attached images */}
        {attachedImages.length > 0 && (
          <div className="mx-4 mb-1.5 flex gap-1.5 shrink-0">
            {attachedImages.map((img, i) => (
              <div key={i} className="relative">
                <img src={img.preview} className="w-12 h-12 rounded-lg object-cover border border-surface-border" />
                <button onClick={() => setAttachedImages(prev => prev.filter((_, j) => j !== i))}
                  className="absolute -top-1 -right-1 bg-bg-800 border border-surface-border rounded-full p-0.5">
                  <X size={6} className="text-neutral-400" />
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Pipeline status */}
        {pipelineStatus && (
          <div className="mx-4 mb-1.5 bg-bg-700/50 border border-surface-border rounded-lg px-3 py-1.5 flex items-center gap-2 shrink-0">
            <Loader size={9} className="animate-spin text-accent shrink-0" />
            <span className="text-[9px] text-neutral-400 flex-1">{pipelineStatus}</span>
          </div>
        )}

        {/* Input */}
        <div className="px-4 py-2.5 border-t border-surface-border bg-bg-800 shrink-0">
          <div className="flex items-end gap-2">
            <label className={`text-neutral-500 hover:text-accent p-1.5 rounded-lg hover:bg-bg-700 shrink-0 mb-0.5 cursor-pointer ${!session ? 'opacity-30 pointer-events-none' : ''}`}>
              <Paperclip size={14} />
              <input ref={fileInputRef} type="file" accept="image/*" multiple className="hidden" onChange={handleAttachImage} />
            </label>
            <textarea value={input} onChange={e => setInput(e.target.value)}
              onKeyDown={handleKeyDown} onPaste={handlePaste}
              placeholder={!session ? 'Start a new chat first' : activeTool ? `🎨 Generate mode — describe what to create` : isVlmAvailable ? 'Type a message... (Shift+Enter for newline)' : 'Select a VLM preset first'}
              disabled={!isVlmAvailable || !session}
              rows={1} className={`flex-1 input-field text-[10px] resize-none max-h-28 leading-relaxed py-2 disabled:opacity-40 ${activeTool ? 'border-amber-500/30' : ''}`}
              style={{ minHeight: '2.25rem' }}
              onInput={(e) => { e.target.style.height = 'auto'; e.target.style.height = Math.min(e.target.scrollHeight, 112) + 'px'; }} />
            <button onClick={() => setActiveTool(activeTool ? null : 'generate_image')}
              title={activeTool ? 'Generate mode ON — click to switch to chat' : 'Switch to generate mode'}
              className={`p-2 rounded-lg shrink-0 mb-0.5 transition-colors ${
                activeTool ? 'bg-amber-500/20 text-amber-400 border border-amber-500/30' : 'text-neutral-600 hover:text-neutral-400 hover:bg-bg-700'}`}>
              <ImageIcon size={14} />
            </button>
            {vc.enabled && (
              <button onClick={handleMicClick} disabled={!isVlmAvailable || !session || cs.isGenerating}
                title={isRecording ? 'Stop recording' : 'Record (push-to-talk)'}
                className={`p-2 rounded-lg shrink-0 mb-0.5 transition-colors ${
                  isRecording ? 'bg-red-500/20 text-red-400 border border-red-500/40 animate-pulse' : 'text-neutral-600 hover:text-neutral-400 hover:bg-bg-700'
                } disabled:opacity-30`}>
                <Mic size={14} />
              </button>
            )}
            {/* Auto-speak toggle — lets the user mute/unmute TTS replies without
                bouncing out to Settings. Only visible when voice chat is enabled. */}
            {vc.enabled && (
              <button onClick={() => vc.setAutoSpeak(!vc.autoSpeak)}
                title={vc.autoSpeak ? 'Auto-speak replies: ON (click to mute)' : 'Auto-speak replies: OFF (click to unmute)'}
                className={`p-2 rounded-lg shrink-0 mb-0.5 transition-colors ${
                  vc.autoSpeak ? 'text-accent hover:bg-bg-700' : 'text-neutral-600 hover:text-neutral-400 hover:bg-bg-700'
                }`}>
                {vc.autoSpeak ? <Volume2 size={14} /> : <VolumeX size={14} />}
              </button>
            )}
            {/* Stop-speaking button — only appears while audio is actually playing,
                whether kicked off by auto-speak or the per-message Speak button.
                Red so the user can't miss it and mid-ramble interruption feels instant. */}
            {vc.enabled && speakingMsgId && (
              <button onClick={stopSpeaking}
                title="Stop speaking"
                className="p-2 rounded-lg shrink-0 mb-0.5 bg-red-500/20 text-red-400 border border-red-500/40 hover:bg-red-500/30 transition-colors animate-pulse">
                <Square size={14} />
              </button>
            )}
            <button onClick={handleSend} disabled={!isVlmAvailable || !session || cs.isGenerating || (!input.trim() && attachedImages.length === 0)}
              className="btn bg-accent text-white p-2 rounded-lg disabled:opacity-30 shrink-0 mb-0.5">
              {cs.isGenerating ? <Loader size={14} className="animate-spin" /> : <Send size={14} />}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
