// Unit tests for src/lib/stripThinking.js — both the `stripThinking` helper
// (already used by directorPipeline, smartSelect, and the VLM tools) and the
// `parseThinking` splitter that ChatPage uses to render a collapsed
// "Thinking" block next to each assistant message.

import { describe, it, expect } from 'vitest';
import { stripThinking, parseThinking, sanitizeForSpeech } from '../src/lib/stripThinking.js';

describe('stripThinking', () => {
  it('returns "" on null/undefined/empty input', () => {
    expect(stripThinking(null)).toBe('');
    expect(stripThinking(undefined)).toBe('');
    expect(stripThinking('')).toBe('');
  });

  it('strips <think> tags', () => {
    expect(stripThinking('<think>reasoning</think>answer')).toBe('answer');
  });

  it('strips <thinking>, <reasoning>, <thought> variants', () => {
    expect(stripThinking('<thinking>r</thinking>a')).toBe('a');
    expect(stripThinking('<reasoning>r</reasoning>a')).toBe('a');
    expect(stripThinking('<thought>r</thought>a')).toBe('a');
  });

  it('strips Gemma <|channel>thought...<channel|> format', () => {
    expect(stripThinking('<|channel>thought\nreasoning<channel|>answer')).toBe('answer');
  });

  it('strips multiple occurrences', () => {
    expect(stripThinking('<think>a</think>x<think>b</think>y')).toBe('xy');
  });

  it('trims surrounding whitespace', () => {
    expect(stripThinking('  <think>r</think>  answer  ')).toBe('answer');
  });

  it('leaves plain text untouched', () => {
    expect(stripThinking('hello world')).toBe('hello world');
  });
});

describe('parseThinking', () => {
  it('returns empty thinking + empty content on null/undefined input', () => {
    expect(parseThinking(null)).toEqual({ thinking: '', content: '' });
    expect(parseThinking(undefined)).toEqual({ thinking: '', content: '' });
    expect(parseThinking('')).toEqual({ thinking: '', content: '' });
  });

  it('returns empty thinking + original text when no tags are present', () => {
    expect(parseThinking('plain answer')).toEqual({ thinking: '', content: 'plain answer' });
  });

  it('splits standard <think> tags', () => {
    const out = parseThinking('<think>let me think</think>the answer');
    expect(out.thinking).toBe('let me think');
    expect(out.content).toBe('the answer');
  });

  it('recognises <thinking>, <reasoning>, <thought> variants', () => {
    expect(parseThinking('<thinking>r</thinking>a')).toEqual({ thinking: 'r', content: 'a' });
    expect(parseThinking('<reasoning>r</reasoning>a')).toEqual({ thinking: 'r', content: 'a' });
    expect(parseThinking('<thought>r</thought>a')).toEqual({ thinking: 'r', content: 'a' });
  });

  it('handles multi-line thinking blocks', () => {
    const src = '<think>\nstep 1\nstep 2\nstep 3\n</think>\nfinal answer';
    const out = parseThinking(src);
    expect(out.thinking).toBe('step 1\nstep 2\nstep 3');
    expect(out.content).toBe('final answer');
  });

  it('splits the Gemma <|channel>thought...<channel|> format', () => {
    const src = '<|channel>thought\ntrace here<channel|>visible answer';
    const out = parseThinking(src);
    expect(out.thinking).toBe('trace here');
    expect(out.content).toBe('visible answer');
  });

  it('handles Gemma empty-thinking case', () => {
    const src = '<|channel>thought\n<channel|>answer';
    const out = parseThinking(src);
    expect(out.thinking).toBe('');
    expect(out.content).toBe('answer');
  });

  it('prefers Gemma format when both could theoretically match', () => {
    // Contrived — checks the regex ordering: Gemma first.
    const src = '<|channel>thought\n<think>inner</think><channel|>answer';
    const out = parseThinking(src);
    // The whole Gemma span — including the inner <think> — is swallowed by
    // the Gemma match; only the post-<channel|> text survives as content.
    expect(out.content).toBe('answer');
    expect(out.thinking).toContain('<think>inner</think>');
  });
});

describe('sanitizeForSpeech', () => {
  it('returns "" on null/undefined/empty input', () => {
    expect(sanitizeForSpeech(null)).toBe('');
    expect(sanitizeForSpeech(undefined)).toBe('');
    expect(sanitizeForSpeech('')).toBe('');
  });

  it('leaves plain prose untouched', () => {
    expect(sanitizeForSpeech('Hello, how are you today?')).toBe('Hello, how are you today?');
  });

  it('unwraps bold delimiters (**foo**)', () => {
    expect(sanitizeForSpeech('This is **very important** advice.'))
      .toBe('This is very important advice.');
  });

  it('unwraps italic delimiters (*foo* and _foo_)', () => {
    expect(sanitizeForSpeech('She said *hello* there.')).toBe('She said hello there.');
    expect(sanitizeForSpeech('She said _hello_ there.')).toBe('She said hello there.');
  });

  it('unwraps double-underscore bold (__foo__)', () => {
    expect(sanitizeForSpeech('Note __this__ carefully.')).toBe('Note this carefully.');
  });

  it('does not leave a dangling single-asterisk after stripping bold', () => {
    const out = sanitizeForSpeech('**prompt engineering**');
    expect(out).toBe('prompt engineering');
    expect(out).not.toContain('*');
  });

  it('unwraps inline code with backticks', () => {
    expect(sanitizeForSpeech('Run `npm install` first.')).toBe('Run npm install first.');
  });

  it('replaces fenced code blocks with a spoken placeholder', () => {
    const src = 'Consider this:\n```js\nconst x = 1;\nconsole.log(x);\n```\nSee?';
    const out = sanitizeForSpeech(src);
    expect(out).toContain('code block');
    expect(out).not.toContain('```');
    expect(out).not.toContain('const x = 1');
  });

  it('converts heading hashes into a sentence break', () => {
    const src = '# Prompt Engineering\nFirst paragraph.';
    const out = sanitizeForSpeech(src);
    expect(out).not.toContain('#');
    expect(out).toContain('Prompt Engineering.');
    expect(out).toContain('First paragraph.');
  });

  it('strips heading markers across levels (##, ###)', () => {
    expect(sanitizeForSpeech('## Setup\nDetails')).not.toContain('#');
    expect(sanitizeForSpeech('### Setup\nDetails')).not.toContain('#');
  });

  it('drops bullet markers at line start', () => {
    const src = '- first item\n- second item\n* third item\n+ fourth item';
    const out = sanitizeForSpeech(src);
    expect(out).not.toMatch(/(^|\s)[-*+]\s/);
    expect(out).toContain('first item');
    expect(out).toContain('second item');
    expect(out).toContain('third item');
    expect(out).toContain('fourth item');
  });

  it('drops numbered-list markers', () => {
    const out = sanitizeForSpeech('1. First\n2. Second\n3. Third');
    expect(out).not.toMatch(/\d+\.\s/);
    expect(out).toContain('First');
    expect(out).toContain('Second');
  });

  it('keeps link text but drops the URL', () => {
    expect(sanitizeForSpeech('See [the docs](https://example.com/path) please.'))
      .toBe('See the docs please.');
  });

  it('drops markdown images entirely', () => {
    expect(sanitizeForSpeech('Look ![a cat](cat.png) here.'))
      .toBe('Look here.');
  });

  it('strips blockquote markers', () => {
    expect(sanitizeForSpeech('> a quoted line')).toBe('a quoted line');
  });

  it('drops horizontal rules', () => {
    const out = sanitizeForSpeech('above\n\n---\n\nbelow');
    expect(out).not.toContain('---');
    expect(out).toContain('above');
    expect(out).toContain('below');
  });

  it('strips common emoji ranges', () => {
    // Face, rocket, checkmark, star — each from a different Unicode block.
    const out = sanitizeForSpeech('Great job 😀 🚀 ✅ ⭐');
    expect(out).toBe('Great job');
  });

  it('strips variation selectors and regional indicators', () => {
    // Flag: 🇺🇸 is two regional-indicator codepoints.
    const out = sanitizeForSpeech('Hello 🇺🇸 world');
    expect(out).toBe('Hello world');
  });

  it('strips box-drawing runes used in ASCII art', () => {
    const out = sanitizeForSpeech('Top ─── line ─── end');
    expect(out).not.toMatch(/[\u2500-\u257F]/);
  });

  it('collapses blank lines into a sentence break', () => {
    const out = sanitizeForSpeech('para one\n\npara two');
    expect(out).toBe('para one. para two');
  });

  it('normalises runs of whitespace to a single space', () => {
    expect(sanitizeForSpeech('too    many     spaces')).toBe('too many spaces');
  });

  it('avoids doubled terminators when a heading already ends in punctuation', () => {
    // Heading "Done!" would naively turn into "Done!." — we fix that.
    const out = sanitizeForSpeech('# Done!\nnext');
    expect(out).toContain('Done!');
    expect(out).not.toContain('!.');
  });

  it('handles a realistic markdown-heavy assistant reply', () => {
    const src = [
      '# Prompt Engineering Tips',
      '',
      'Here are some things to keep in mind when writing prompts:',
      '',
      '- Be **specific** about what you want.',
      '- Provide *examples* where possible.',
      '- Use `code blocks` for literal strings.',
      '',
      'For more, see [the guide](https://example.com/guide). 🚀',
    ].join('\n');
    const out = sanitizeForSpeech(src);
    // No raw markdown tokens should survive.
    expect(out).not.toMatch(/[*#`\[\]()]/);
    expect(out).not.toContain('https');
    expect(out).not.toMatch(/[\u{1F300}-\u{1F9FF}]/u);
    // Key words from each bullet should still be present.
    expect(out).toContain('specific');
    expect(out).toContain('examples');
    expect(out).toContain('code blocks');
    expect(out).toContain('the guide');
  });
});
