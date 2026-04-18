/**
 * VLM Tool: Image to Video Prompt
 * 
 * Takes an image (base64) and optionally user guidance,
 * sends to VLM, returns a video generation prompt.
 * 
 * Modes:
 *   - auto: VLM fully auto-generates tags + prompt (runFullAutoI2V)
 *   - guided: User provides direction, VLM creates detailed prompt
 *   - describe: VLM describes what a video of this image should look like
 */
import * as vlm from '../vlmClient';
import { stripThinking } from '../stripThinking';

export const imageToVideo = {
  name: 'imageToVideo',
  description: 'Generate a video prompt from an image using VLM analysis',
  requiresVlm: true,

  run: async (params, vlmConfig, appConfig) => {
    const { imageBase64, mode, userGuidance, originalPrompt, onStatus } = params;
    const statusCb = onStatus || (() => {});

    if (mode === 'auto') {
      const raw = await vlm.runFullAutoI2V({
        modelPath: vlmConfig.modelPath, mmprojPath: vlmConfig.mmprojPath,
        ctx: vlmConfig.ctx, imageTokens: vlmConfig.imageTokens, imageBase64,
        afterInference: appConfig?.afterInference || 'park',
        onStatus: statusCb, pythonPath: appConfig?.pythonPath || 'python',
        onPhaseComplete: () => {},
      });
      return { prompt: stripThinking(raw), mode: 'auto' };
    }

    const origPrompt = originalPrompt || '';
    const userPrompt = userGuidance
      ? `Look at this image and create a video prompt based on the user's direction. User wants: "${userGuidance}". The original image prompt was: "${origPrompt}". Write a detailed video generation prompt describing motion, camera, and atmosphere. Keep it under 100 words.`
      : `Describe a short video animation based on this image. The image was created with the prompt: "${origPrompt}". Describe what should move, how the camera should behave, and what the atmosphere should be. Keep it under 100 words.`;

    const raw = await vlm.runVlmPipeline({
      modelPath: vlmConfig.modelPath, mmprojPath: vlmConfig.mmprojPath,
      ctx: vlmConfig.ctx, imageTokens: vlmConfig.imageTokens, imageBase64,
      userPrompt, systemPrompt: '',
      afterInference: appConfig?.afterInference || 'park',
      onStatus: statusCb, pythonPath: appConfig?.pythonPath || 'python',
    });
    return { prompt: stripThinking(raw), mode: 'guided' };
  },
};
