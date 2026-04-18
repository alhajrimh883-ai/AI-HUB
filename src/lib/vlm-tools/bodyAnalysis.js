/**
 * VLM Tool: Body Analysis
 * 
 * Analyzes an AI-generated image for anatomical issues using VLM.
 * Returns a fix instruction or "no fix needed".
 * 
 * Used by:
 *   - Director pipeline (auto body fix before I2V)
 *   - Studio ImageOverlay (manual body fix)
 */
import * as vlm from '../vlmClient';
import { stripThinking } from '../stripThinking';

const BODY_ANALYSIS_PROMPT = `Look at this AI-generated image carefully. Describe any anatomical issues: extra fingers, malformed hands, broken limbs, distorted faces, or unnatural body proportions. Write a short editing instruction to fix ONLY the body issues without changing the art style, composition, or concept. If the image looks fine, respond with just "no fix needed". Output ONLY the instruction.`;

export const bodyAnalysis = {
  name: 'bodyAnalysis',
  description: 'Analyze image for anatomical issues and generate fix instructions',
  requiresVlm: true,

  /** The default analysis prompt (exported for customization) */
  defaultPrompt: BODY_ANALYSIS_PROMPT,

  /**
   * @param {object} params
   * @param {string} params.imageBase64 — base64 encoded image
   * @param {string} [params.customPrompt] — override the default analysis prompt
   * @param {function} [params.onStatus] — status callback
   * @param {object} vlmConfig — { modelPath, mmprojPath, ctx, imageTokens }
   * @param {object} appConfig — { afterInference, pythonPath }
   * @returns {Promise<{ instruction: string, needsFix: boolean }>}
   */
  run: async (params, vlmConfig, appConfig) => {
    const { imageBase64, customPrompt, onStatus } = params;
    const statusCb = onStatus || (() => {});

    statusCb('Analyzing image for anatomical issues...');

    const result = await vlm.runVlmPipeline({
      modelPath: vlmConfig.modelPath,
      mmprojPath: vlmConfig.mmprojPath,
      ctx: vlmConfig.ctx,
      imageTokens: vlmConfig.imageTokens,
      imageBase64,
      userPrompt: customPrompt || BODY_ANALYSIS_PROMPT,
      systemPrompt: '',
      afterInference: appConfig?.afterInference || 'park',
      onStatus: statusCb,
      pythonPath: appConfig?.pythonPath || 'python',
    });

    const instruction = stripThinking(result || '');
    const needsFix = !instruction.toLowerCase().includes('no fix needed');

    return { instruction, needsFix };
  },
};
