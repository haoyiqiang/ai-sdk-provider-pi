import type { Model, Api } from '@earendil-works/pi-ai';
import type { PiProviderSettings, PiLanguageModelSettings } from './types.js';

/**
 * Validates and parses a Pi model ID string.
 * Supports formats:
 * - "anthropic/claude-sonnet-4" (provider/modelId)
 * - "sonnet" (convenience alias)
 *
 * @param modelId - The model ID to parse
 * @returns Parsed provider and model ID
 * @throws Error if the model ID is empty or malformed
 */
export function parseModelId(modelId: string): {
  provider: string;
  modelId: string;
} {
  if (!modelId || modelId.trim() === '') {
    throw new Error('Model ID cannot be empty');
  }

  // Check if it's a provider/model format
  if (modelId.includes('/')) {
    const parts = modelId.split('/');
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      throw new Error(
        `Invalid model ID format: '${modelId}'. Expected format: 'provider/model-id' (e.g., 'anthropic/claude-sonnet-4')`
      );
    }
    return { provider: parts[0], modelId: parts[1] };
  }

  // Convenience aliases for common models
  const aliases: Record<string, { provider: string; modelId: string }> = {
    'sonnet': { provider: 'anthropic', modelId: 'claude-sonnet-4' },
    'opus': { provider: 'anthropic', modelId: 'claude-opus-4' },
    'haiku': { provider: 'anthropic', modelId: 'claude-haiku-4' },
    'gpt-4o': { provider: 'openai', modelId: 'gpt-4o' },
    'gpt-4o-mini': { provider: 'openai', modelId: 'gpt-4o-mini' },
    'o3': { provider: 'openai', modelId: 'o3' },
    'o4-mini': { provider: 'openai', modelId: 'o4-mini' },
    'gemini-2.5-pro': { provider: 'google', modelId: 'gemini-2.5-pro' },
    'gemini-2.5-flash': { provider: 'google', modelId: 'gemini-2.5-flash' },
    'deepseek-v4-flash': { provider: 'deepseek', modelId: 'deepseek-v4-flash' },
    'deepseek-v4-pro': { provider: 'deepseek', modelId: 'deepseek-v4-pro' },
    'deepseek-chat': { provider: 'deepseek', modelId: 'deepseek-v4-flash' },
    'deepseek-reasoner': { provider: 'deepseek', modelId: 'deepseek-v4-pro' },
  };

  const alias = aliases[modelId.toLowerCase()];
  if (alias) {
    return alias;
  }

  throw new Error(
    `Unknown model alias: '${modelId}'. Use the 'provider/model-id' format (e.g., 'anthropic/claude-sonnet-4') or a known alias: ${Object.keys(aliases).join(', ')}`
  );
}

/**
 * Validates Pi provider settings and returns warnings.
 */
export function validateProviderSettings(
  settings: PiProviderSettings
): { warnings: string[] } {
  const warnings: string[] = [];

  // Warn about high turn limits
  if (settings.verbose) {
    warnings.push('Verbose logging is enabled — this may impact performance');
  }

  return { warnings };
}

/**
 * Validates Pi language model settings and returns warnings.
 */
export function validateModelSettings(
  settings: PiLanguageModelSettings
): { warnings: string[] } {
  const warnings: string[] = [];

  // Warn about high turn limits
  if (settings.maxTurns && settings.maxTurns > 50) {
    warnings.push(
      `High maxTurns value (${settings.maxTurns}) may lead to long-running conversations`
    );
  }

  // Warn about both tools and excludeTools
  if (settings.tools && settings.excludeTools) {
    warnings.push(
      'Both tools and excludeTools are specified. The excludeTools filter will be applied after the tools whitelist.'
    );
  }

  return { warnings };
}

/**
 * Validates that a model is available in the registry.
 *
 * @param provider - The provider name
 * @param modelId - The model ID
 * @param modelRegistry - The model registry to check against
 * @returns Warning if model is not found or not configured
 */
export function validateModelAvailability(
  provider: string,
  modelId: string,
  modelRegistry: { find: (provider: string, modelId: string) => Model<Api> | undefined; hasConfiguredAuth: (model: Model<Api>) => boolean }
): { warnings: string[]; model: Model<Api> | undefined } {
  const warnings: string[] = [];

  const model = modelRegistry.find(provider, modelId);
  if (!model) {
    warnings.push(
      `Model '${provider}/${modelId}' not found in registry. Available models may differ from what you expect.`
    );
    return { warnings, model: undefined };
  }

  if (!modelRegistry.hasConfiguredAuth(model)) {
    warnings.push(
      `No API key configured for provider '${provider}'. Set it via auth.json, environment variable, or AuthStorage.setRuntimeApiKey().`
    );
  }

  return { warnings, model };
}
