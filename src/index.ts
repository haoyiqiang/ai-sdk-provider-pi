/**
 * AI SDK Provider for Pi Coding Agent
 *
 * This provider bridges Pi Coding Agent's session-based API to the
 * AI SDK's LanguageModelV3 interface, enabling seamless use of Pi's
 * 15+ LLM providers with AI SDK's streamText(), generateText(),
 * useChat(), and ai-elements components.
 *
 * @module pi
 */

/**
 * Message conversion utilities.
 * Converts AI SDK ModelMessage[] to Pi SDK Context format.
 */
export {
  buildPromptFromContext,
  convertToPiMessages,
} from "./convert-to-pi-messages.js";
export type { PiErrorMetadata } from "./errors.js";
/**
 * Error handling utilities for Pi provider.
 * These functions help create and identify specific error types.
 */
export {
  createAPICallError,
  createAuthenticationError,
  createContextOverflowError,
  createTimeoutError,
  getErrorMetadata,
  handlePiError,
  isAuthenticationError,
  isContextOverflowError,
  isTimeoutError,
} from "./errors.js";
/**
 * Finish reason mapping.
 * Maps Pi SDK stopReason values to AI SDK finish reasons.
 */
export { mapPiFinishReason } from "./map-pi-finish-reason.js";
/**
 * Language model implementation for Pi.
 * This class implements the AI SDK's LanguageModelV3 interface.
 */
export { PiLanguageModel } from "./pi-language-model.js";
/**
 * Type definitions for the Pi provider.
 * @see {@link PiProvider} for the provider interface
 * @see {@link PiProviderSettings} for provider configuration options
 */
export type { PiProvider } from "./pi-provider.js";
/**
 * Creates a new Pi provider instance and the default provider instance.
 * @see {@link createPi} for creating custom provider instances
 * @see {@link pi} for the default provider instance
 */
export { createPi, pi } from "./pi-provider.js";
/**
 * Type definitions for the Pi provider.
 * @see {@link PiModelId} for model identifier format
 * @see {@link PiProviderSettings} for provider-level configuration
 * @see {@link PiLanguageModelSettings} for model-level configuration
 * @see {@link PiLanguageModelOptions} for model constructor options
 * @see {@link Logger} for custom logging interface
 * @see {@link PiProviderMetadata} for stream part metadata
 */
export type {
  /**
   * Tool operation contracts, re-exported from @earendil-works/pi-coding-agent
   * so provider consumers share a single source of truth. Use these to build
   * custom sandbox operations passed via SandboxConfig.operations.
   */
  BashOperations,
  EditOperations,
  Logger,
  ParsedModelId,
  PiLanguageModelOptions,
  PiLanguageModelSettings,
  PiModelId,
  PiProviderMetadata,
  PiProviderSettings,
  ReadOperations,
  SandboxConfig,
  ToolStreamState,
  WriteOperations,
} from "./types.js";

/**
 * Validation utilities.
 * Validates model IDs, provider settings, and model settings.
 */
export {
  parseModelId,
  validateModelAvailability,
  validateModelSettings,
  validateProviderSettings,
} from "./validation.js";
