/**
 * Thinking-tag helpers for VLM output.
 *
 * Supports:
 *   • Standard: <think>...</think>, <thinking>...</thinking>,
 *               <reasoning>...</reasoning>, <thought>...</thought>
 *   • Gemma 4:  <|channel>thought\n[reasoning]<channel|>[answer]
 *               <|channel>thought\n<channel|>[answer]  (empty thinking)
 *
 * stripThinking  — returns the visible content only (drops thinking).
 * parseThinking  — returns { thinking, content } so the UI can show the
 *                  thinking in a collapsed block next to the answer.
 */

export function stripThinking(text) {
  if (!text) return '';
  return text
    .replace(/<\|channel>thought[\s\S]*?<channel\|>/gi, '')
    .replace(/<(?:think|thinking|reasoning|thought)>[\s\S]*?<\/(?:think|thinking|reasoning|thought)>/gi, '')
    .trim();
}

export function parseThinking(text) {
  if (!text) return { thinking: '', content: text || '' };

  // Gemma 4 channel format — check first; the delimiters are unique.
  const gemmaMatch = text.match(/<\|channel>thought\n?([\s\S]*?)<channel\|>([\s\S]*)/);
  if (gemmaMatch) {
    return {
      thinking: gemmaMatch[1].trim(),
      content: gemmaMatch[2].trim(),
    };
  }

  // Standard <think>, <thinking>, <reasoning>, <thought> tags.
  const thinkMatch = text.match(/<(?:think|thinking|reasoning|thought)>([\s\S]*?)<\/(?:think|thinking|reasoning|thought)>/i);
  if (!thinkMatch) return { thinking: '', content: text };
  const thinking = thinkMatch[1].trim();
  const content = text.replace(thinkMatch[0], '').trim();
  return { thinking, content };
}

/**
 * Clean a string for TTS synthesis. Piper happily pronounces every asterisk,
 * hash, and emoji name ("star star prompt engineering star star"), which is
 * both annoying and slow. This function:
 *   1. drops code blocks (Piper can't pronounce JSON sensibly anyway)
 *   2. unwraps markdown bold / italic / inline-code (keeps the text, drops
 *      the delimiters)
 *   3. strips heading hashes, bullet markers, and horizontal rules
 *   4. unwraps markdown links — keeps the visible text, drops the URL
 *   5. strips common emoji / pictograph unicode blocks
 *   6. collapses whitespace so blank lines don't translate to long silences
 *
 * Returns a plain-prose string ready to hand to Piper.
 */
export function sanitizeForSpeech(text) {
  if (!text) return '';
  let s = String(text);

  // 1. Code fences ``` ... ``` — replaced with a short spoken placeholder
  //    instead of deleted outright so the listener knows code was elided.
  s = s.replace(/```[\s\S]*?```/g, ' (code block) ');

  // 2. Markdown images ![alt](url) — drop entirely (alt text is usually noise).
  s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, '');

  // 3. Markdown links [text](url) — keep text, drop url.
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1');

  // 4. Inline code `foo` — keep foo, drop backticks.
  s = s.replace(/`([^`]+)`/g, '$1');

  // 5. Bold / italic delimiters. Order matters: do ** before * so we don't
  //    leave a dangling single-asterisk.
  s = s.replace(/\*\*([^*]+)\*\*/g, '$1');
  s = s.replace(/\*([^*]+)\*/g, '$1');
  s = s.replace(/__([^_]+)__/g, '$1');
  s = s.replace(/(^|\s)_([^_\n]+)_(\s|$|[.,!?;:])/g, '$1$2$3');

  // 6. Heading hashes (#, ##, ### at line start). Turn into a sentence break
  //    so "Heading\n" becomes "Heading." and Piper pauses naturally.
  s = s.replace(/^\s{0,3}#{1,6}\s+(.+)$/gm, '$1.');

  // 7. Bullet / numbered-list markers at line start.
  s = s.replace(/^\s*[-*+]\s+/gm, '');
  s = s.replace(/^\s*\d+\.\s+/gm, '');

  // 8. Blockquote markers.
  s = s.replace(/^\s*>+\s?/gm, '');

  // 9. Horizontal rules (---, ***, ___).
  s = s.replace(/^\s*(?:---+|\*\*\*+|___+)\s*$/gm, '');

  // 10. Emoji / pictograph blocks. Ranges cover the common offenders — misc
  //     symbols & pictographs, dingbats, transport, extended-A/B, regional
  //     indicators, misc symbols & arrows (⭐ lives here), misc technical
  //     (⏰⌛), and the variation-selector that often trails an emoji.
  s = s.replace(/[\u{1F300}-\u{1F9FF}]/gu, '');
  s = s.replace(/[\u{2600}-\u{27BF}]/gu, '');
  s = s.replace(/[\u{2B00}-\u{2BFF}]/gu, '');
  s = s.replace(/[\u{2300}-\u{23FF}]/gu, '');
  s = s.replace(/[\u{1F000}-\u{1F2FF}]/gu, '');
  s = s.replace(/[\u{1FA00}-\u{1FAFF}]/gu, '');
  s = s.replace(/[\u{1F1E6}-\u{1F1FF}]/gu, '');
  s = s.replace(/\uFE0F/g, '');

  // 11. Box-drawing runes sometimes used for ASCII art.
  s = s.replace(/[\u2500-\u257F]/g, '');

  // 12. Collapse runs of blank lines into a single sentence break so Piper
  //     doesn't pause awkwardly, and normalise whitespace.
  s = s.replace(/\n{2,}/g, '. ');
  s = s.replace(/\s+/g, ' ').trim();

  // 13. Fix doubled terminators we may have introduced ("Heading.." → "Heading.")
  s = s.replace(/([.!?])\s*\.(\s|$)/g, '$1$2');

  return s;
}
