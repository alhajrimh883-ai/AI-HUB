import React, { useState } from 'react';
import { ChevronDown, ChevronRight, Brain } from 'lucide-react';

/**
 * Collapsible thinking block — renders the VLM's reasoning tag contents
 * as an expandable section above the visible answer.
 * Extracted from ChatPage.jsx during the April 2026 Chat stabilization pass.
 */
export default function ThinkingBlock({ text }) {
  const [expanded, setExpanded] = useState(false);
  if (!text) return null;
  return (
    <div className="mb-1.5">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1 text-[8px] text-violet-400/70 hover:text-violet-300 transition-colors"
      >
        {expanded ? <ChevronDown size={8} /> : <ChevronRight size={8} />}
        <Brain size={8} />
        <span>
          Thinking
          {!expanded && <span className="text-neutral-600 ml-1">({text.length} chars)</span>}
        </span>
      </button>
      {expanded && (
        <div className="mt-1 pl-3 border-l-2 border-violet-500/20">
          <p className="text-[9px] text-neutral-500 leading-relaxed whitespace-pre-wrap">{text}</p>
        </div>
      )}
    </div>
  );
}
