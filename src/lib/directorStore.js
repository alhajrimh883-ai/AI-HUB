/**
 * AI Director — State Management
 */
import { create } from 'zustand';
import { saveSettings } from './settingsPersist';

const DIRECTOR_PERSIST_KEYS = [
  // Settings
  'targetLength', 'segmentDuration', 'resetEnabled', 'resetInterval', 'qualityPreset', 'resolution', 'highRes',
  't2iCheckpoint', 'videoEngine', 'videoPreset',
  'bodyFixCheckpoint', 'hireFixCheckpoint', 'hireFixMode', 'hireFixUpscaleBy', 'hireFixDenoise', 'hireFixUpscaleModel',
  'useHireFix', 'useBodyFix',
  'usePlanner', 'plannerMaxRetries',
  'directorFrameCount',
  'useSmartLora', 'loraPresets',
  'autoApprove',
  'cameraMode', 'lightingMode',
  'timingHistory',
  // Templates
  'templateResearch', 'templateSynthesize', 'templateImage', 'templateI2V', 'templateExtend',
  'templatePlan', 'templatePlanReview', 'templateLoraSelect',
];

// ─── Default prompt templates ────────────────────────────────────────

export const DEFAULT_TEMPLATE_RESEARCH = `Generate 3-5 web search queries to find WRITTEN DESCRIPTIONS and factual details about the visual elements in this project. We need TEXT information, NOT images.

Good queries find: articles describing appearance, guides about traditional clothing details, wiki pages about architecture styles, blog posts describing color palettes, historical descriptions of settings.
Bad queries: "images of...", "visual reference...", "photos of...", "pictures of..." — these return image results which we cannot use.

User wants: {intent}
{brief}
Research topics: {hint}

Output ONLY the search queries, one per line, numbered. Each query should find descriptive text about specific visual details (materials, colors, patterns, proportions, atmosphere). Nothing else.`;

export const DEFAULT_TEMPLATE_SYNTHESIZE = `You are a visual reference researcher for an AI video project.

User wants: {intent}
{brief}

Search Results:
{snippets}

Synthesize these into concise Visual Style Notes — bullet points describing:
- Key visual details (colors, textures, materials)
- Architecture/setting specifics
- Clothing/costume details
- Lighting and atmosphere
- Any useful physical/motion descriptors

Output ONLY the style notes. Be specific and descriptive.`;

export const DEFAULT_TEMPLATE_IMAGE = `You are writing a prompt for an AI image generator. This image is the OPENING FRAME of a {totalDuration}-second video that will have {totalSegs} segments.

User wants: {intent}
{brief}
{research}
{motionStyle}

This is segment {segNum} of {totalSegs}. This image sets the stage for everything that follows.
IMPORTANT: This is just the starting frame — don't put the climax or main action here. Set up the scene, show the environment, establish the subject in a natural starting position. The action will build across the following video segments.

Write a detailed image prompt: subject, setting, composition, lighting, mood. One paragraph.
Output ONLY the image prompt, nothing else.`;

export const DEFAULT_TEMPLATE_I2V = `You are writing a prompt for a {segDuration}-second AI video clip. This is segment {segNum} of {totalSegs} in a {totalDuration}-second video.

User wants: {intent}
{brief}
{research}
{motionStyle}
{resumeContext}

You are looking at the opening frame. This is the FIRST video segment — it brings the still image to life.
IMPORTANT PACING: You only have {segDuration} seconds. Write motion that can realistically happen in {segDuration} seconds — small natural movements, a gesture, a slow camera move. Don't cram a full action sequence into one short clip.
There are {totalSegs} total segments, so pace yourself. The story continues in the next segments.

Describe:
- What moves and how (be specific about body/object motion)
- Camera movement (follow the camera control rule below)
- Atmosphere and pacing

{cameraControl}
{lightingControl}

One paragraph. Output ONLY the video prompt, nothing else.`;

export const DEFAULT_TEMPLATE_EXTEND = `You are writing a prompt for a {segDuration}-second AI video clip. This is segment {segNum} of {totalSegs} in a {totalDuration}-second video.

User wants: {intent}
{brief}
{research}
{motionStyle}
{resumeContext}

You are looking at frames from the previous segment. Based on our conversation so far, write what happens NEXT.
IMPORTANT PACING: You only have {segDuration} seconds for this segment. Write motion that naturally continues from where the last clip ended and fits within {segDuration} seconds.
{segsRemaining}Don't rush to the conclusion unless this is the final segment.

{cameraControl}
{lightingControl}

Describe the continuation: what moves, camera changes, atmosphere shifts.
One paragraph. Output ONLY the video prompt, nothing else.`;

export const DEFAULT_TEMPLATE_PLAN = `You are a cinematic video planner. Plan a {totalSegs}-segment video sequence totaling {totalDuration} seconds ({segDuration} seconds per segment).

User wants: {intent}
{brief}
{research}
{motionStyle}

Rules:
- Segment 1 is a STILL IMAGE (T2I) — this is the opening frame, it sets the scene
- Segments 2+ are {segDuration}-second video clips — each must contain motion that fits in {segDuration} seconds
- Start with buildup/establishment, NOT the main action immediately
- Build visual interest across segments — wide → medium → close-up → action
- Each description should specify: what's visible, what moves, camera angle
- Pace the story so it naturally fills {totalDuration} seconds without rushing

{cameraControl}
{lightingControl}

Output EXACTLY {totalSegs} lines, one per segment. Number them. Nothing else.`;

export const DEFAULT_TEMPLATE_PLAN_REVIEW = `You are a quality reviewer for AI-generated video.

The plan for this segment was:
"{planDescription}"

You are looking at frames from the generated output.
Does the output match the plan? Consider:
- Does it show what was described?
- Is the composition/framing appropriate?
- Are there major visual artifacts or broken anatomy?

Respond with EXACTLY one of:
APPROVED - if the output reasonably matches the plan
REJECTED: [one sentence explaining what's wrong and how to fix it]`;

export const DEFAULT_TEMPLATE_LORA_SELECT = `You are choosing LoRA models for AI generation.

User wants: {intent}
{brief}

This LoRA preset is called: "{loraName}"
Description: {loraDescription}
Tags: {loraTags}
Target: {loraTarget}

Should this LoRA be used for this project? Consider if the style, motion, or effect described matches what the user wants to create.

Respond with EXACTLY one word: YES or NO`;

// ─── Store ───────────────────────────────────────────────────────────

const useDirectorStore = create((set, get) => ({
  // User inputs
  userIntent: '',       // REQUIRED — "what do you want?"
  storyBrief: '',       // optional
  researchHint: '',     // optional
  motionStyle: '',      // optional
  inputImage: null,    // { name, preview } — skip T2I
  inputVideo: null,    // { name, preview } — skip T2I + I2V
  resumeContext: '',   // user description of the input image/video

  // Camera & Lighting control
  cameraMode: 'smart',    // 'static' | 'dynamic' | 'smart'
  lightingMode: 'locked', // 'locked' | 'natural' | 'creative'

  // Timing tracker — measured from actual generations
  // { image: [seconds], i2v: [seconds], extend: [seconds], bodyfix: [seconds], hirefix: [seconds], vlm: [seconds] }
  timingHistory: { image: [], i2v: [], extend: [], bodyfix: [], hirefix: [], vlm: [] },
  currentEstimate: null,  // { remaining, total, text } — shown in UI

  // Research
  researchResults: '',
  researchPhase: 'idle',
  researchStatus: '',
  researchLog: [],  // [{type: 'info'|'vlm'|'search'|'error', text, timestamp}]

  // Pipeline
  pipelineState: 'idle', // 'idle' | 'running' | 'paused' | 'complete' | 'error'
  pipelinePhase: '',     // 'image' | 'i2v' | 'extend' | ''
  pipelineStatus: '',
  autoApprove: true,

  // Segments
  segments: [],
  currentSegmentIndex: -1,

  // Settings
  targetLength: 20,     // total seconds
  segmentDuration: 5,   // per extend chunk
  resetEnabled: false, // Periodic reset cycle to prevent degradation
  resetInterval: 4,    // Reset every N extend segments
  qualityPreset: 'fast',
  resolution: 'portrait',
  highRes: false,

  // Model settings
  t2iCheckpoint: '',
  videoEngine: 'wan22',
  videoPreset: 'fast',
  bodyFixCheckpoint: '',   // edit model for body fix
  hireFixCheckpoint: '',   // edit model for hirefix
  hireFixMode: 'fast',     // 'fast' | 'latent'
  hireFixUpscaleBy: 1.5,
  hireFixDenoise: 0.4,
  hireFixUpscaleModel: '',

  // Post-processing
  useHireFix: false,
  useBodyFix: false,

  // Planner
  usePlanner: false,
  plannerMaxRetries: 2,    // max regen attempts per segment
  plannerSegments: [],     // [{description, approved}] — the plan
  plannerVisible: false,   // show plan panel in UI

  // VLM Director settings
  directorFrameCount: 8,  // frames extracted per segment for VLM

  // LoRA Presets — user-defined, persisted
  // Each: { id, name, description, target: 'image'|'video', engine: 'wan22'|'ltx23'|'any',
  //         scope: 'global'|'per-segment',
  //         loraHigh: { file, strength }, loraLow: { file, strength } | null, tags: [] }
  loraPresets: [],
  useSmartLora: false,
  selectedLoraIds: [],   // IDs selected by VLM for current run

  // VLM History
  vlmHistory: [],  // [{ role: 'app'|'vlm', phase, text, timestamp }]

  // Current prompt (for review)
  currentPrompt: '',
  awaitingApproval: false,

  // Templates (editable)
  templateResearch: DEFAULT_TEMPLATE_RESEARCH,
  templateSynthesize: DEFAULT_TEMPLATE_SYNTHESIZE,
  templateImage: DEFAULT_TEMPLATE_IMAGE,
  templateI2V: DEFAULT_TEMPLATE_I2V,
  templateExtend: DEFAULT_TEMPLATE_EXTEND,
  templatePlan: DEFAULT_TEMPLATE_PLAN,
  templatePlanReview: DEFAULT_TEMPLATE_PLAN_REVIEW,
  templateLoraSelect: DEFAULT_TEMPLATE_LORA_SELECT,

  // Error
  error: null,

  // ── Setters ──
  setUserIntent: (v) => set({ userIntent: v }),
  setStoryBrief: (v) => set({ storyBrief: v }),
  setResearchHint: (v) => set({ researchHint: v }),
  setMotionStyle: (v) => set({ motionStyle: v }),
  setInputImage: (v) => set({ inputImage: v }),
  setInputVideo: (v) => set({ inputVideo: v }),
  setResumeContext: (v) => set({ resumeContext: v }),
  setCameraMode: (v) => set({ cameraMode: v }),
  setLightingMode: (v) => set({ lightingMode: v }),

  // Timing
  recordTiming: (type, seconds) => set(s => {
    const h = { ...s.timingHistory };
    h[type] = [...(h[type] || []), seconds].slice(-20); // keep last 20
    return { timingHistory: h };
  }),
  setCurrentEstimate: (v) => set({ currentEstimate: v }),
  getAvgTime: (type) => {
    const arr = get().timingHistory[type] || [];
    if (arr.length < 2) return null;
    return arr.reduce((a, b) => a + b, 0) / arr.length;
  },
  setResearchResults: (v) => set({ researchResults: v }),
  setResearchPhase: (v) => set({ researchPhase: v }),
  setResearchStatus: (v) => set({ researchStatus: v }),
  addResearchLog: (type, text) => set(s => ({ researchLog: [...s.researchLog, { type, text, timestamp: Date.now() }] })),
  clearResearchLog: () => set({ researchLog: [] }),
  setPipelineState: (v) => set({ pipelineState: v }),
  setPipelinePhase: (v) => set({ pipelinePhase: v }),
  setPipelineStatus: (v) => set({ pipelineStatus: v }),
  setAutoApprove: (v) => set({ autoApprove: v }),
  setSegments: (v) => set({ segments: v }),
  setCurrentSegmentIndex: (v) => set({ currentSegmentIndex: v }),
  setTargetLength: (v) => set({ targetLength: v }),
  setSegmentDuration: (v) => set({ segmentDuration: v }),
  setResetEnabled: (v) => set({ resetEnabled: v }),
  setResetInterval: (v) => set({ resetInterval: v }),
  setQualityPreset: (v) => set({ qualityPreset: v }),
  setResolution: (v) => set({ resolution: v }),
  setHighRes: (v) => set({ highRes: v }),
  setT2iCheckpoint: (v) => set({ t2iCheckpoint: v }),
  setVideoEngine: (v) => set({ videoEngine: v }),
  setVideoPreset: (v) => set({ videoPreset: v }),
  setBodyFixCheckpoint: (v) => set({ bodyFixCheckpoint: v }),
  setHireFixCheckpoint: (v) => set({ hireFixCheckpoint: v }),
  setHireFixMode: (v) => set({ hireFixMode: v }),
  setHireFixUpscaleBy: (v) => set({ hireFixUpscaleBy: v }),
  setHireFixDenoise: (v) => set({ hireFixDenoise: v }),
  setHireFixUpscaleModel: (v) => set({ hireFixUpscaleModel: v }),
  setUseHireFix: (v) => set({ useHireFix: v }),
  setUseBodyFix: (v) => set({ useBodyFix: v }),
  setUsePlanner: (v) => set({ usePlanner: v }),
  setPlannerMaxRetries: (v) => set({ plannerMaxRetries: v }),
  setPlannerSegments: (v) => set({ plannerSegments: v }),
  setPlannerVisible: (v) => set({ plannerVisible: v }),
  updatePlannerSegment: (idx, data) => set(s => {
    const segs = [...s.plannerSegments];
    segs[idx] = { ...segs[idx], ...data };
    return { plannerSegments: segs };
  }),
  setDirectorFrameCount: (v) => set({ directorFrameCount: v }),
  setLoraPresets: (v) => set({ loraPresets: v }),
  addLoraPreset: (preset) => set(s => ({ loraPresets: [...s.loraPresets, { ...preset, id: `lp_${Date.now()}` }] })),
  removeLoraPreset: (id) => set(s => ({ loraPresets: s.loraPresets.filter(p => p.id !== id) })),
  updateLoraPreset: (id, data) => set(s => ({ loraPresets: s.loraPresets.map(p => p.id === id ? { ...p, ...data } : p) })),
  setUseSmartLora: (v) => set({ useSmartLora: v }),
  setSelectedLoraIds: (v) => set({ selectedLoraIds: v }),
  setTemplateResearch: (v) => set({ templateResearch: v }),
  setTemplateSynthesize: (v) => set({ templateSynthesize: v }),
  setTemplateImage: (v) => set({ templateImage: v }),
  setTemplateI2V: (v) => set({ templateI2V: v }),
  setTemplateExtend: (v) => set({ templateExtend: v }),
  setTemplatePlan: (v) => set({ templatePlan: v }),
  setTemplatePlanReview: (v) => set({ templatePlanReview: v }),
  setTemplateLoraSelect: (v) => set({ templateLoraSelect: v }),
  addVlmHistory: (entry) => set(s => ({ vlmHistory: [...s.vlmHistory, { ...entry, timestamp: Date.now() }] })),
  clearVlmHistory: () => set({ vlmHistory: [] }),
  setCurrentPrompt: (v) => set({ currentPrompt: v }),
  setAwaitingApproval: (v) => set({ awaitingApproval: v }),
  setError: (v) => set({ error: v }),

  // ── Helpers ──
  updateSegment: (idx, updates) => {
    const segs = [...get().segments];
    if (segs[idx]) segs[idx] = { ...segs[idx], ...updates };
    set({ segments: segs });
  },

  reset: () => set({
    researchResults: '', researchPhase: 'idle', researchStatus: '', researchLog: [],
    pipelineState: 'idle', pipelinePhase: '', pipelineStatus: '',
    segments: [], currentSegmentIndex: -1, currentPrompt: '',
    awaitingApproval: false, error: null, vlmHistory: [],
    plannerSegments: [], plannerVisible: false, selectedLoraIds: [],
  }),

  fullReset: () => set({
    storyBrief: '', researchHint: '', motionStyle: '',
    inputImage: null, inputVideo: null,
    researchResults: '', researchPhase: 'idle', researchStatus: '', researchLog: [],
    pipelineState: 'idle', pipelinePhase: '', pipelineStatus: '',
    segments: [], currentSegmentIndex: -1, currentPrompt: '',
    awaitingApproval: false, error: null,
  }),

  /**
   * Fill a template with context variables.
   */
  fillTemplate: (template, extra = {}) => {
    const s = get();
    let out = template;
    out = out.replace(/\{intent\}/g, s.userIntent || '');
    out = out.replace(/\{brief\}/g, s.storyBrief ? `Story: ${s.storyBrief}` : '');
    out = out.replace(/\{hint\}/g, s.researchHint || '');
    out = out.replace(/\{research\}/g, s.researchResults ? `Visual Reference:\n${s.researchResults}` : '');
    out = out.replace(/\{motionStyle\}/g, s.motionStyle ? `Motion Style: ${s.motionStyle}` : '');
    out = out.replace(/\{resumeContext\}/g, s.resumeContext ? `Resume context: ${s.resumeContext}` : '');

    // Camera control instruction
    const camInstructions = {
      static: 'CAMERA: Keep the camera completely STATIC throughout. No pans, tilts, dollies, zooms, or any camera movement. The frame stays locked in place.',
      dynamic: 'CAMERA: Use dynamic camera movement — pans, dollies, tracking shots, crane moves. Make the cinematography feel alive and cinematic.',
      smart: 'CAMERA: Use camera movement ONLY when it serves the action. If the subject is moving, the camera can follow naturally. If the subject is stationary, keep the camera still. Never move the camera just for style — it must have a reason tied to what the subject is doing.',
    };
    out = out.replace(/\{cameraControl\}/g, camInstructions[s.cameraMode] || camInstructions.smart);

    // Lighting control instruction
    const lightInstructions = {
      locked: 'LIGHTING: Maintain consistent lighting throughout. Do NOT introduce new light sources, sun flares, lens flares, dramatic lighting shifts, or color temperature changes. Keep the same lighting established in the first frame.',
      natural: 'LIGHTING: Lighting can shift subtly and naturally (e.g. clouds passing, walking into shade) but avoid dramatic or sudden changes. No lens flares, no artificial color grading shifts, no spotlight effects.',
      creative: 'LIGHTING: You may adjust lighting creatively to enhance mood — golden hour shifts, shadow play, volumetric light. Keep it cinematic but grounded.',
    };
    out = out.replace(/\{lightingControl\}/g, lightInstructions[s.lightingMode] || lightInstructions.locked);
    out = out.replace(/\{snippets\}/g, extra.snippets || '');
    out = out.replace(/\{lastPrompt\}/g, extra.lastPrompt || 'N/A');
    out = out.replace(/\{promptHistory\}/g, extra.promptHistory || 'None yet');
    out = out.replace(/\{segNum\}/g, String(extra.segNum || 1));
    out = out.replace(/\{totalSegs\}/g, String(extra.totalSegs || 1));
    out = out.replace(/\{segDuration\}/g, String(s.segmentDuration || 5));
    out = out.replace(/\{totalDuration\}/g, String(s.targetLength || 20));
    const remaining = (extra.totalSegs || 1) - (extra.segNum || 1);
    out = out.replace(/\{segsRemaining\}/g, remaining > 0 ? `Segments remaining after this: ${remaining}. ` : 'This is the FINAL segment. ');
    out = out.replace(/\{planDescription\}/g, extra.planDescription || '');
    out = out.replace(/\{loraName\}/g, extra.loraName || '');
    out = out.replace(/\{loraDescription\}/g, extra.loraDescription || '');
    out = out.replace(/\{loraTags\}/g, extra.loraTags || '');
    out = out.replace(/\{loraTarget\}/g, extra.loraTarget || '');
    // Clean up empty lines from unfilled optionals
    out = out.replace(/\n\s*\n\s*\n/g, '\n\n');
    return out.trim();
  },

  loadPersistedState: (data) => {
    const patch = {};
    for (const key of DIRECTOR_PERSIST_KEYS) {
      if (data[`dir_${key}`] !== undefined) patch[key] = data[`dir_${key}`];
    }
    if (Object.keys(patch).length > 0) set(patch);
  },
}));

// Auto-save persisted keys on change (debounced via saveSettings)
let prevState = {};
useDirectorStore.subscribe((state) => {
  const toSave = {};
  let changed = false;
  for (const key of DIRECTOR_PERSIST_KEYS) {
    if (state[key] !== prevState[key]) {
      toSave[`dir_${key}`] = state[key];
      changed = true;
    }
  }
  prevState = state;
  if (changed) saveSettings(toSave);
});

export default useDirectorStore;
