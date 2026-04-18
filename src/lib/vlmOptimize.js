/**
 * VLM Auto-Optimize profile table — maps the user's GPU name to sensible
 * defaults for context size, image tokens, video frames, analysis mode,
 * and after-inference memory behavior.
 *
 * Lives in its own module so the AppSettings Auto-Optimize button and the
 * first-run wizard's VLM screen pick identical values — no drift.
 *
 * If the GPU can't be matched we return a conservative mid-tier profile
 * (8 GB class card) which is the safest default for an unknown machine.
 */

const PROFILES = [
  { match: ['4060', '3060'],         ctx: 4096,  img: 256,  frames: 2, mode: 'single', after: 'unload', label: '8 GB class (RTX 3060/4060)' },
  { match: ['4070', '3070'],         ctx: 8192,  img: 512,  frames: 4, mode: 'single', after: 'park',   label: '12 GB class (RTX 3070/4070)' },
  { match: ['4080', '3080', '5080'], ctx: 8192,  img: 1024, frames: 4, mode: 'multi',  after: 'park',   label: '16 GB class (RTX 3080/4080/5080)' },
  { match: ['4090', '3090'],         ctx: 16384, img: 1024, frames: 6, mode: 'multi',  after: 'park',   label: '24 GB class (RTX 3090/4090)' },
  { match: ['5090'],                 ctx: 16384, img: 2048, frames: 8, mode: 'multi',  after: 'park',   label: '32 GB class (RTX 5090)' },
];

const FALLBACK = { ctx: 8192, img: 1024, frames: 4, mode: 'single', after: 'park', label: 'Unknown GPU — conservative default' };

/**
 * @param {string} gpuName  Free-form GPU name (as returned by vlmSystemInfo).
 * @returns {{ctx, img, frames, mode, after, label}}
 */
export function getAutoOptimizeProfile(gpuName) {
  const name = String(gpuName || '').toLowerCase();
  return PROFILES.find(p => p.match.some(m => name.includes(m))) || FALLBACK;
}

/**
 * Apply a profile to the main store in one shot. Caller passes the store's
 * setters to keep this module a pure helper (no React/Zustand imports).
 *
 * @param {{ctx:number,img:number,frames:number,mode:string,after:string}} profile
 * @param {{
 *   setVlmCtx, setVlmImageTokens, setVlmTargetFrames, setVlmVideoMode, setVlmAfterInference
 * }} setters
 */
export function applyAutoOptimizeProfile(profile, setters) {
  setters.setVlmCtx?.(profile.ctx);
  setters.setVlmImageTokens?.(profile.img);
  setters.setVlmTargetFrames?.(profile.frames);
  setters.setVlmVideoMode?.(profile.mode);
  setters.setVlmAfterInference?.(profile.after);
}
