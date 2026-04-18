/**
 * Smart Select Engine
 * VLM decides. App manages: filtering by type, batching long lists, sequencing, validation.
 * Separate inference context — never touches chat history.
 *
 * Flow:
 *   1. App filters presets by type/mode (management, not intelligence)
 *   2. VLM picks preset from the list
 *   3. App checks: does the chosen preset have linked LoRAs?
 *   4. If yes → VLM picks LoRAs (batched if list is long)
 *   5. App validates VLM's choices point to real IDs
 */

import { stripThinking } from './stripThinking';

// ═══════════════════════════════════
// ── Phase 1: Preset Selection ──
// ═══════════════════════════════════

/** App management: filter by type and mode. Not intelligence, just correctness. */
function filterPresets(presets, type, mode) {
  return presets.filter(p => {
    if (p.type !== type) return false;
    if (p.mode === 'both' || p.mode === 'combined') return true;
    return p.mode === mode;
  });
}

/** Build VLM prompt for preset selection */
function buildPresetPrompt(prompt, presets) {
  let msg = `The user wants to generate with this prompt:\n"${prompt}"\n\nChoose the best preset:\n`;
  presets.forEach((p, i) => {
    msg += `${i + 1}. "${p.name}"`;
    if (p.description) msg += ` — ${p.description}`;
    msg += '\n';
  });
  msg += '\nRespond ONLY with JSON: {"pick": <number>, "reason": "<one sentence>"}';
  return msg;
}

/** Validate VLM response → return preset or null */
function parsePresetResponse(response, presets) {
  try {
    const clean = stripThinking(response);
    const json = clean.match(/\{[\s\S]*?\}/);
    if (!json) return null;
    const { pick, reason } = JSON.parse(json[0]);
    const idx = parseInt(pick) - 1;
    if (idx >= 0 && idx < presets.length) return { preset: presets[idx], reasoning: reason || '' };
    return null;
  } catch { return null; }
}

/** Phase 1: VLM picks a preset */
async function selectPreset({ prompt, type, mode, presets, infer }) {
  const filtered = filterPresets(presets, type, mode);
  if (filtered.length === 0) return null;
  if (filtered.length === 1) return { preset: filtered[0], reasoning: 'Only available preset.' };

  // No VLM available — return first (user's default)
  if (!infer) return { preset: filtered[0], reasoning: 'No VLM — using default.' };

  try {
    const vlmPrompt = buildPresetPrompt(prompt, filtered);
    const response = await infer(vlmPrompt, 'You are a preset selector. Pick the best match. Respond ONLY with JSON.');
    const result = parsePresetResponse(response, filtered);
    if (result) return result;
  } catch (err) {
    console.warn('[SmartSelect] Preset VLM failed:', err.message);
  }

  return { preset: filtered[0], reasoning: 'VLM failed — using default.' };
}

// ═══════════════════════════════════
// ── Phase 2: LoRA Selection ──
// ═══════════════════════════════════

const BATCH_SIZE = 8;

/** Build VLM prompt for a batch of LoRAs */
function buildLoraPrompt(prompt, batch, batchNum, totalBatches) {
  let msg = `User prompt: "${prompt}"\n\nWhich LoRAs should be activated?`;
  if (totalBatches > 1) msg += ` (set ${batchNum}/${totalBatches})`;
  msg += '\n';
  batch.forEach((l, i) => {
    msg += `${i + 1}. "${l.name}"`;
    if (l.description) msg += ` — ${l.description}`;
    if (l.tags?.length) msg += ` [${l.tags.join(', ')}]`;
    msg += '\n';
  });
  msg += '\nRespond ONLY with JSON: {"picks": [<numbers>], "reason": "<one sentence>"}\nUse empty array [] if none fit.';
  return msg;
}

/** Validate VLM response → return selected LoRAs */
function parseLoraResponse(response, batch) {
  try {
    const clean = stripThinking(response);
    const json = clean.match(/\{[\s\S]*?\}/);
    if (!json) return [];
    const { picks } = JSON.parse(json[0]);
    if (!Array.isArray(picks)) return [];
    return picks.map(n => batch[parseInt(n) - 1]).filter(Boolean);
  } catch { return []; }
}

/** Phase 2: VLM picks LoRAs. App batches if list is long. */
async function selectLoras({ prompt, preset, loraPresets, infer }) {
  // App management: check if preset has linked LoRAs
  if (!preset.linkedLoraIds?.length) return { loras: [], reasoning: 'No linked LoRAs.' };

  // App management: gather the actual LoRA objects
  const linked = preset.linkedLoraIds
    .map(id => loraPresets.find(l => l.id === id))
    .filter(Boolean);
  if (linked.length === 0) return { loras: [], reasoning: 'Linked LoRAs not found.' };

  // No VLM — include all linked (safe default)
  if (!infer) return { loras: linked, reasoning: 'No VLM — using all linked LoRAs.' };

  // App management: batch the list so VLM sees manageable chunks
  const batches = [];
  for (let i = 0; i < linked.length; i += BATCH_SIZE) {
    batches.push(linked.slice(i, i + BATCH_SIZE));
  }

  const selected = [];
  const reasons = [];

  for (let i = 0; i < batches.length; i++) {
    try {
      const vlmPrompt = buildLoraPrompt(prompt, batches[i], i + 1, batches.length);
      const response = await infer(vlmPrompt, 'Select LoRAs to activate. Respond ONLY with JSON.');
      const picked = parseLoraResponse(response, batches[i]);
      selected.push(...picked);
      const reason = response.match(/"reason"\s*:\s*"([^"]+)"/)?.[1];
      if (reason) reasons.push(reason);
    } catch (err) {
      console.warn(`[SmartSelect] LoRA batch ${i + 1} failed:`, err.message);
    }
  }

  return {
    loras: selected,
    reasoning: reasons.join(' ') || `Selected ${selected.length}/${linked.length} LoRAs.`,
  };
}

// ═══════════════════════════════════
// ── Main Entry ──
// ═══════════════════════════════════

/**
 * Smart select: preset first → LoRAs second.
 *
 * @param {string} opts.prompt — user prompt
 * @param {string} opts.type — 't2i' | 'video' | 'edit' | 'hirefix'
 * @param {string} opts.mode — 'fast' | 'quality'
 * @param {Array} opts.presets — all presets from store
 * @param {Array} opts.loraPresets — all LoRA presets from store
 * @param {Function|null} opts.infer — async (userPrompt, systemPrompt) => string
 *                                      Standalone call. Separate context from chat.
 * @returns {{ preset, loras: [], reasoning: { preset, loras } } | null}
 */
export async function smartSelect({ prompt, type, mode, presets, loraPresets, infer = null }) {
  if (!prompt?.trim()) return null;

  // Phase 1: VLM picks preset (app filters by type/mode first)
  const presetResult = await selectPreset({ prompt, type, mode, presets, infer });
  if (!presetResult) return null;

  // Phase 2: VLM picks LoRAs (app checks if any exist, batches if long)
  const loraResult = await selectLoras({
    prompt, preset: presetResult.preset, loraPresets, infer,
  });

  return {
    preset: presetResult.preset,
    loras: loraResult.loras,
    reasoning: {
      preset: presetResult.reasoning,
      loras: loraResult.reasoning,
    },
  };
}

/**
 * Is smart select possible? (multiple presets exist for this type)
 */
export function canSmartSelect(presets, type, mode) {
  return filterPresets(presets, type, mode).length > 1;
}

export { selectPreset, selectLoras, filterPresets };
