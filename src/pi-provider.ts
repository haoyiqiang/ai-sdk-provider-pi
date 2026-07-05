import type { LanguageModelV3, ProviderV3 } from "@ai-sdk/provider";
import { NoSuchModelError } from "@ai-sdk/provider";
import type { Api, Model } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai";
import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { PiLanguageModel } from "./pi-language-model.js";
import type {
  PiLanguageModelSettings,
  PiModelId,
  PiProviderSettings,
} from "./types.js";
import {
  parseModelId,
  validateModelAvailability,
  validateModelSettings,
  validateProviderSettings,
} from "./validation.js";

/**
 * Pi provider interface that extends the AI SDK's ProviderV3.
 * Provides methods to create language models powered by Pi Coding Agent.
 *
 * @example
 * ```typescript
 * import { createPi } from 'ai-sdk-provider-pi';
 *
 * // Create a provider with default settings
 * const pi = createPi();
 *
 * // Create a model instance using provider/model format
 * const model = pi('anthropic/claude-sonnet-4');
 *
 * // Or use convenience aliases
 * const sonnet = pi('sonnet');
 *
 * // Use with AI SDK
 * import { generateText } from 'ai';
 * const { text } = await generateText({
 *   model: pi('anthropic/claude-sonnet-4'),
 *   prompt: 'Hello!'
 * });
 * ```
 */
export interface PiProvider extends ProviderV3 {
  /**
   * Creates a language model instance for the specified model ID.
   * This is a shorthand for calling `languageModel()`.
   *
   * @param modelId - The model ID (e.g., 'anthropic/claude-sonnet-4' or 'sonnet')
   * @param settings - Optional settings to configure the model
   * @returns A language model instance
   */
  (modelId: PiModelId, settings?: PiLanguageModelSettings): LanguageModelV3;

  /**
   * Creates a language model instance for text generation.
   *
   * @param modelId - The model ID (e.g., 'anthropic/claude-sonnet-4' or 'sonnet')
   * @param settings - Optional settings to configure the model
   * @returns A language model instance
   */
  languageModel(
    modelId: PiModelId,
    settings?: PiLanguageModelSettings,
  ): LanguageModelV3;

  /**
   * Alias for `languageModel()` to maintain compatibility with AI SDK patterns.
   */
  chat(modelId: PiModelId, settings?: PiLanguageModelSettings): LanguageModelV3;

  imageModel(modelId: string): never;
}

/**
 * Creates a Pi provider instance with the specified configuration.
 *
 * @param options - Provider configuration options
 * @returns Pi provider instance
 *
 * @example
 * ```typescript
 * const pi = createPi({
 *   authStorage: AuthStorage.create(),
 *   cwd: '/path/to/project',
 *   noTools: 'all',  // Disable all tools for pure chat
 * });
 *
 * const model = pi('anthropic/claude-sonnet-4');
 * ```
 */
export function createPi(options: PiProviderSettings = {}): PiProvider {
  // Validate provider settings
  const providerValidation = validateProviderSettings(options);

  // Initialize shared resources lazily
  let authStorage: AuthStorage | undefined;
  let modelRegistry: ModelRegistry | undefined;

  const getAuthStorage = (): AuthStorage => {
    if (!authStorage) {
      authStorage = options.authStorage ?? AuthStorage.create();
    }
    return authStorage;
  };

  const getModelRegistry = (): ModelRegistry => {
    if (!modelRegistry) {
      modelRegistry =
        options.modelRegistry ?? ModelRegistry.create(getAuthStorage());
    }
    return modelRegistry;
  };

  /**
   * Resolves a model ID string to a Pi Model object.
   */
  const resolveModel = (modelId: PiModelId): Model<Api> => {
    const parsed = parseModelId(modelId);

    // Try to get from Pi's built-in model registry
    try {
      const model = getModel(parsed.provider as any, parsed.modelId as any);
      if (model) {
        return model;
      }
    } catch {
      // Not found in built-in registry, try the custom model registry
    }

    // Try the custom model registry
    const registry = getModelRegistry();
    const model = registry.find(parsed.provider, parsed.modelId);
    if (model) {
      return model;
    }

    throw new NoSuchModelError({
      modelId,
      modelType: "languageModel",
    });
  };

  const createModel = (
    modelId: PiModelId,
    settings: PiLanguageModelSettings = {},
  ): LanguageModelV3 => {
    // Merge provider-level settings with model-level settings
    const mergedSettings: PiLanguageModelSettings = {
      ...settings,
      // Provider-level cwd as fallback
      cwd: settings.cwd ?? options.cwd,
      // Provider-level tool settings as fallback
      tools: settings.tools ?? options.tools,
      excludeTools: settings.excludeTools ?? options.excludeTools,
    };

    // Validate model settings
    const modelValidation = validateModelSettings(mergedSettings);

    // Resolve the model
    const model = resolveModel(modelId);

    // Check model availability (warnings only, don't block)
    const registry = getModelRegistry();
    const availability = validateModelAvailability(
      model.provider,
      model.id,
      registry,
    );

    const allWarnings = [
      ...providerValidation.warnings,
      ...modelValidation.warnings,
      ...availability.warnings,
    ];

    return new PiLanguageModel({
      id: modelId,
      model,
      settings: mergedSettings,
      providerSettings: options,
      settingsValidationWarnings: allWarnings,
    });
  };

  const provider = function (
    modelId: PiModelId,
    settings?: PiLanguageModelSettings,
  ) {
    if (new.target) {
      throw new Error(
        "The Pi model function cannot be called with the new keyword.",
      );
    }

    return createModel(modelId, settings);
  };

  provider.languageModel = createModel;
  provider.chat = createModel;
  provider.specificationVersion = "v3" as const;

  provider.embeddingModel = (modelId: string) => {
    throw new NoSuchModelError({
      modelId,
      modelType: "embeddingModel",
    });
  };

  provider.imageModel = (modelId: string) => {
    throw new NoSuchModelError({
      modelId,
      modelType: "imageModel",
    });
  };

  return provider as PiProvider;
}

/**
 * Default Pi provider instance.
 * Pre-configured provider for quick usage without custom settings.
 *
 * @example
 * ```typescript
 * import { pi } from 'ai-sdk-provider-pi';
 * import { generateText } from 'ai';
 *
 * const { text } = await generateText({
 *   model: pi('anthropic/claude-sonnet-4'),
 *   prompt: 'Hello!'
 * });
 * ```
 */
export const pi = createPi();
