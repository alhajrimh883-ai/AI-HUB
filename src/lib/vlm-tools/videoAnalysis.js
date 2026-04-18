/**
 * VLM Tool: Video Analysis
 * 
 * Extracts frames from a video and prepares them for VLM analysis.
 * Used by the Director for video-to-video continuation prompts.
 * 
 * The app controls HOW frames are extracted (single/multi-frame).
 * This tool handles the extraction + VLM content building.
 * The actual VLM call is made by the caller (Director) since it
 * manages chat history and context.
 */
import * as vlm from '../vlmClient';

export const videoAnalysis = {
  name: 'videoAnalysis',
  description: 'Extract video frames and prepare content for VLM video continuation analysis',
  requiresVlm: false, // Frame extraction doesn't need VLM — the caller handles VLM calls

  /**
   * Extract frames from a video for VLM analysis
   * @param {object} params
   * @param {string} params.videoUrl — URL to the video (ComfyUI served)
   * @param {number} params.frameCount — how many frames to extract
   * @param {function} [params.onStatus] — status callback
   * @returns {Promise<{ frames: string[], lastFrame: string, count: number }>}
   *   frames: array of base64 images
   *   lastFrame: base64 of the last frame
   *   count: actual number of frames extracted
   */
  run: async (params) => {
    const { videoUrl, frameCount, onStatus } = params;
    const statusCb = onStatus || (() => {});

    if (!videoUrl) return { frames: [], lastFrame: '', count: 0 };

    try {
      statusCb(`Extracting ${frameCount} frames...`);
      const extracted = await vlm.extractVideoFrames(videoUrl, frameCount, statusCb);
      const frames = [...(extracted.frames || []), extracted.lastFrame].filter(Boolean);
      return {
        frames,
        lastFrame: extracted.lastFrame || frames[frames.length - 1] || '',
        count: frames.length,
      };
    } catch (e) {
      return { frames: [], lastFrame: '', count: 0, error: e.message };
    }
  },

  /**
   * Build multi-image content array for VLM chat message
   * @param {string[]} frameBase64s — array of base64 frame images
   * @param {string} textPrompt — the text to accompany the frames
   * @returns {Array} content array for VLM chat message
   */
  buildFrameContent: (frameBase64s, textPrompt) => {
    if (!frameBase64s.length) return textPrompt;
    const content = [];
    for (const b64 of frameBase64s) {
      content.push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b64}` } });
    }
    content.push({ type: 'text', text: textPrompt });
    return content;
  },

  /**
   * Estimate token usage for a set of frames
   * @param {number} frameCount
   * @param {number} imageTokens — tokens per frame
   * @param {number} promptTokens — estimated text tokens
   * @returns {{ total: number, pct: number }} token count and % of context
   */
  estimateTokens: (frameCount, imageTokens, ctxLength, promptTokens = 150) => {
    const total = (frameCount * imageTokens) + promptTokens;
    const pct = Math.round((total / ctxLength) * 100);
    return { total, pct, fits: pct < 90 };
  },
};
