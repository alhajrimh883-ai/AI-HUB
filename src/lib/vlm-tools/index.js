/**
 * VLM Tools Registry
 * 
 * Central registry for all VLM tools. The app calls tools through this module.
 * Each tool is a self-contained module that:
 *   - Receives structured input
 *   - Calls the VLM via vlmClient
 *   - Returns structured output
 * 
 * Tools never modify core app files. The app and VLM call OUT to tools.
 */

import { imageToVideo } from './imageToVideo';
import { videoAnalysis } from './videoAnalysis';
import { bodyAnalysis } from './bodyAnalysis';

// ── Tool Registry ──
const TOOLS = {
  imageToVideo,
  videoAnalysis,
  bodyAnalysis,
};

/**
 * Get a tool by name
 * @param {string} name — tool identifier
 * @returns {object|null} tool module
 */
export function getTool(name) {
  return TOOLS[name] || null;
}

/**
 * List all registered tools
 * @returns {Array} [{ name, description, requiresVlm }]
 */
export function listTools() {
  return Object.entries(TOOLS).map(([name, tool]) => ({
    name,
    description: tool.description,
    requiresVlm: tool.requiresVlm,
  }));
}

/**
 * Run a tool with VLM config auto-resolved from preset store
 * @param {string} toolName — tool identifier
 * @param {object} params — tool-specific parameters
 * @param {object} vlmConfig — { enabled, modelPath, mmprojPath, ctx, imageTokens }
 * @param {object} appConfig — { afterInference, pythonPath, videoMode, targetFrames }
 * @returns {Promise<object>} tool result
 */
export async function runTool(toolName, params, vlmConfig, appConfig) {
  const tool = TOOLS[toolName];
  if (!tool) throw new Error(`Unknown VLM tool: ${toolName}`);
  if (tool.requiresVlm && !vlmConfig?.enabled) {
    throw new Error(`Tool "${toolName}" requires a VLM preset. Select one in the header bar.`);
  }
  return tool.run(params, vlmConfig, appConfig);
}

export { TOOLS };
