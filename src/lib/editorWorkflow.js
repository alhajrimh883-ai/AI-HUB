/**
 * Editor Workflow Engine
 * Builds overlay (quick edit) and tab (full editor) workflows.
 */

import overlayBase from '../../workflow/EditorOverlay.json';

export const EDITOR = {
  VAE_DECODE:    '148',
  CHECKPOINT:    '149',
  PREVIEW:       '150',
  NEG_PROMPT:    '151',
  LOAD_IMG3:     '154',
  LOAD_IMG2:     '156',
  KSAMPLER:      '157',
  POS_PROMPT:    '158',
  LOAD_IMG1:     '160',
  STEPS:         '161',
  CFG:           '162',
  SEED:          '163',
  BATCH_SIZE:    '164',
  RES_SWITCH:    '168',
};

export const EDITOR_RESOLUTIONS = {
  portrait:  { switchVal: 3 },
  square:    { switchVal: 1 },
  landscape: { switchVal: 2 },
};

function deepCopy(obj) { return JSON.parse(JSON.stringify(obj)); }

/**
 * Build quick edit overlay workflow (single image, no settings control).
 */
export function buildEditorOverlay({ imageName, prompt, resolution, checkpoint }) {
  const wf = deepCopy(overlayBase);

  // Image
  wf[EDITOR.LOAD_IMG1].inputs.image = imageName;

  // Positive prompt (edit instruction)
  wf[EDITOR.POS_PROMPT].inputs.prompt = prompt || '';

  // Negative stays blank (workflow default)

  // Checkpoint override
  if (checkpoint) wf[EDITOR.CHECKPOINT].inputs.ckpt_name = checkpoint;

  // Resolution — match the source image
  if (resolution && EDITOR_RESOLUTIONS[resolution]) {
    wf[EDITOR.RES_SWITCH].inputs.selection_setting = EDITOR_RESOLUTIONS[resolution].switchVal;
  }

  // Overlay always uses defaults: batch=1, seed=0, steps=4, cfg=1
  return wf;
}

/**
 * Build full editor tab workflow (1-3 images, full settings control).
 * Removes image2/image3 nodes and connections if not provided.
 */
