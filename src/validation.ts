import type { Api, Model } from "@earendil-works/pi-ai";
import type {
  Logger,
  PiLanguageModelSettings,
  PiProviderSettings,
} from "./types.js";

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
  if (!modelId || modelId.trim() === "") {
    throw new Error("Model ID cannot be empty");
  }

  // Check if it's a provider/model format
  if (modelId.includes("/")) {
    const parts = modelId.split("/");
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      throw new Error(
        `Invalid model ID format: '${modelId}'. Expected format: 'provider/model-id' (e.g., 'anthropic/claude-sonnet-4')`,
      );
    }
    return { provider: parts[0], modelId: parts[1] };
  }

  // Convenience aliases for common models
  const aliases: Record<string, { provider: string; modelId: string }> = {
    sonnet: { provider: "anthropic", modelId: "claude-sonnet-4" },
    opus: { provider: "anthropic", modelId: "claude-opus-4" },
    haiku: { provider: "anthropic", modelId: "claude-haiku-4" },
    "gpt-4o": { provider: "openai", modelId: "gpt-4o" },
    "gpt-4o-mini": { provider: "openai", modelId: "gpt-4o-mini" },
    o3: { provider: "openai", modelId: "o3" },
    "o4-mini": { provider: "openai", modelId: "o4-mini" },
    "gemini-2.5-pro": { provider: "google", modelId: "gemini-2.5-pro" },
    "gemini-2.5-flash": { provider: "google", modelId: "gemini-2.5-flash" },
    "deepseek-v4-flash": { provider: "deepseek", modelId: "deepseek-v4-flash" },
    "deepseek-v4-pro": { provider: "deepseek", modelId: "deepseek-v4-pro" },
    "deepseek-chat": { provider: "deepseek", modelId: "deepseek-v4-flash" },
    "deepseek-reasoner": { provider: "deepseek", modelId: "deepseek-v4-pro" },
  };

  const alias = aliases[modelId.toLowerCase()];
  if (alias) {
    return alias;
  }

  throw new Error(
    `Unknown model alias: '${modelId}'. Use the 'provider/model-id' format (e.g., 'anthropic/claude-sonnet-4') or a known alias: ${Object.keys(aliases).join(", ")}`,
  );
}

/**
 * Known keys for PiProviderSettings.
 */
const PROVIDER_SETTINGS_KEYS = new Set([
  "authStorage",
  "modelRegistry",
  "sessionManager",
  "cwd",
  "agentDir",
  "tools",
  "excludeTools",
  "noTools",
  "customTools",
  "sandbox",
  "verbose",
  "logger",
]);

/**
 * Known keys for PiLanguageModelSettings.
 */
const MODEL_SETTINGS_KEYS = new Set([
  "thinkingLevel",
  "maxTurns",
  "systemPrompt",
  "appendSystemPrompt",
  "cwd",
  "tools",
  "excludeTools",
  "maxBudgetUsd",
  "maxToolResultSize",
  "sandbox",
]);

/**
 * Validates that an object only contains known keys.
 * Throws on first unknown key found.
 */
function validateKnownKeys(
  obj: Record<string, unknown>,
  knownKeys: Set<string>,
  context: string,
): void {
  for (const key of Object.keys(obj)) {
    if (!knownKeys.has(key)) {
      throw new Error(
        `Unknown setting '${key}' in ${context}. Allowed keys: ${[...knownKeys].sort().join(", ")}`,
      );
    }
  }
}

/**
 * Validates that a logger object has the required methods.
 */
function validateLoggerShape(logger: unknown): asserts logger is Logger {
  if (logger === null || typeof logger !== "object") {
    throw new Error(
      "Logger must be a non-null object with methods: debug, info, warn, error",
    );
  }

  const required = ["debug", "info", "warn", "error"] as const;
  for (const method of required) {
    if (typeof (logger as Record<string, unknown>)[method] !== "function") {
      throw new Error(
        `Logger must implement a '${method}' method (received: ${typeof (logger as Record<string, unknown>)[method]})`,
      );
    }
  }
}

/**
 * Validates Pi provider settings, rejecting unknown keys and validating
 * the logger shape. Returns warnings for advisory conditions.
 */
export function validateProviderSettings(settings: PiProviderSettings): {
  warnings: string[];
} {
  const warnings: string[] = [];

  // Reject unknown keys
  validateKnownKeys(
    settings as Record<string, unknown>,
    PROVIDER_SETTINGS_KEYS,
    "provider settings",
  );

  // Validate optional logger shape
  if (settings.logger !== undefined && settings.logger !== false) {
    validateLoggerShape(settings.logger);
  }

  // Warn about verbose logging
  if (settings.verbose) {
    warnings.push("Verbose logging is enabled — this may impact performance");
  }

  return { warnings };
}

/**
 * Validates Pi language model settings, rejecting unknown keys.
 * Returns warnings for advisory conditions.
 */
export function validateModelSettings(settings: PiLanguageModelSettings): {
  warnings: string[];
} {
  const warnings: string[] = [];

  // Reject unknown keys
  validateKnownKeys(
    settings as Record<string, unknown>,
    MODEL_SETTINGS_KEYS,
    "model settings",
  );

  // Warn about high turn limits
  if (settings.maxTurns && settings.maxTurns > 50) {
    warnings.push(
      `High maxTurns value (${settings.maxTurns}) may lead to long-running conversations`,
    );
  }

  // Warn about both tools and excludeTools
  if (settings.tools && settings.excludeTools) {
    warnings.push(
      "Both tools and excludeTools are specified. The excludeTools filter will be applied after the tools whitelist.",
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
  modelRegistry: {
    find: (provider: string, modelId: string) => Model<Api> | undefined;
    hasConfiguredAuth: (model: Model<Api>) => boolean;
  },
): { warnings: string[]; model: Model<Api> | undefined } {
  const warnings: string[] = [];

  const model = modelRegistry.find(provider, modelId);
  if (!model) {
    warnings.push(
      `Model '${provider}/${modelId}' not found in registry. Available models may differ from what you expect.`,
    );
    return { warnings, model: undefined };
  }

  if (!modelRegistry.hasConfiguredAuth(model)) {
    warnings.push(
      `No API key configured for provider '${provider}'. Set it via auth.json, environment variable, or AuthStorage.setRuntimeApiKey().`,
    );
  }

  return { warnings, model };
}
