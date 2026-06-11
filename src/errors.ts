import { APICallError, LoadAPIKeyError } from '@ai-sdk/provider';

/**
 * Metadata associated with Pi SDK errors.
 * Provides additional context about agent session failures.
 */
export interface PiErrorMetadata {
  /**
   * Error code (e.g., 'ENOENT', 'ETIMEDOUT', 'AUTH_FAILED').
   */
  code?: string;

  /**
   * The Pi provider that failed (e.g., 'anthropic', 'openai').
   */
  provider?: string;

  /**
   * The model ID that was being used.
   */
  modelId?: string;

  /**
   * The Pi session ID where the error occurred.
   */
  sessionId?: string;

  /**
   * Excerpt from the prompt that caused the error.
   * Limited to first 200 characters for debugging.
   */
  promptExcerpt?: string;

  /**
   * Original error message from the Pi SDK.
   */
  originalMessage?: string;
}

/**
 * Creates an APICallError with Pi-specific metadata.
 * Used for general agent session errors.
 */
export function createAPICallError({
  message,
  code,
  provider,
  modelId,
  sessionId,
  promptExcerpt,
  originalMessage,
  isRetryable = false,
}: PiErrorMetadata & {
  message: string;
  isRetryable?: boolean;
}): APICallError {
  const metadata: PiErrorMetadata = {
    code,
    provider,
    modelId,
    sessionId,
    promptExcerpt,
    originalMessage,
  };

  return new APICallError({
    message,
    isRetryable,
    url: `pi://${provider ?? 'unknown'}/${modelId ?? 'unknown'}`,
    requestBodyValues: promptExcerpt ? { prompt: promptExcerpt } : undefined,
    data: metadata,
  });
}

/**
 * Creates an authentication error for Pi SDK API key failures.
 */
export function createAuthenticationError({
  message,
  provider,
}: {
  message: string;
  provider?: string;
}): LoadAPIKeyError {
  const providerHint = provider
    ? ` for provider "${provider}"`
    : '';
  return new LoadAPIKeyError({
    message:
      message ||
      `Pi authentication failed${providerHint}. Please ensure the API key is configured via auth.json, environment variable, or AuthStorage.setRuntimeApiKey().`,
  });
}

/**
 * Creates a timeout error for Pi SDK operations.
 */
export function createTimeoutError({
  message,
  provider,
  modelId,
  promptExcerpt,
  timeoutMs,
}: {
  message: string;
  provider?: string;
  modelId?: string;
  promptExcerpt?: string;
  timeoutMs?: number;
}): APICallError {
  const metadata: PiErrorMetadata & { timeoutMs?: number } = {
    code: 'TIMEOUT',
    provider,
    modelId,
    promptExcerpt,
  };

  return new APICallError({
    message,
    isRetryable: true,
    url: `pi://${provider ?? 'unknown'}/${modelId ?? 'unknown'}`,
    requestBodyValues: promptExcerpt ? { prompt: promptExcerpt } : undefined,
    data: timeoutMs !== undefined ? { ...metadata, timeoutMs } : metadata,
  });
}

/**
 * Creates a context overflow error when the conversation exceeds the model's context window.
 */
export function createContextOverflowError({
  message,
  provider,
  modelId,
  promptExcerpt,
}: {
  message: string;
  provider?: string;
  modelId?: string;
  promptExcerpt?: string;
}): APICallError {
  return new APICallError({
    message,
    isRetryable: false,
    url: `pi://${provider ?? 'unknown'}/${modelId ?? 'unknown'}`,
    requestBodyValues: promptExcerpt ? { prompt: promptExcerpt } : undefined,
    data: {
      code: 'CONTEXT_OVERFLOW',
      provider,
      modelId,
      promptExcerpt,
    } satisfies PiErrorMetadata,
  });
}

/**
 * Handles errors from Pi SDK operations, converting them to AI SDK errors.
 */
export function handlePiError(
  error: unknown,
  {
    provider,
    modelId,
    sessionId,
    promptExcerpt,
  }: {
    provider?: string;
    modelId?: string;
    sessionId?: string;
    promptExcerpt?: string;
  } = {}
): never {
  // Already an AI SDK error — re-throw as-is
  if (error instanceof APICallError || error instanceof LoadAPIKeyError) {
    throw error;
  }

  // Standard Error with message
  if (error instanceof Error) {
    const message = error.message;

    // Authentication errors
    if (
      message.includes('API key') ||
      message.includes('authentication') ||
      message.includes('Unauthorized') ||
      message.includes('401') ||
      message.includes('auth')
    ) {
      throw createAuthenticationError({ message, provider });
    }

    // Context overflow
    if (
      message.includes('context') ||
      message.includes('token limit') ||
      message.includes('too many tokens') ||
      message.includes('prompt is too long')
    ) {
      throw createContextOverflowError({
        message,
        provider,
        modelId,
        promptExcerpt,
      });
    }

    // Timeout
    if (
      message.includes('timeout') ||
      message.includes('timed out') ||
      message.includes('ETIMEDOUT')
    ) {
      throw createTimeoutError({
        message,
        provider,
        modelId,
        promptExcerpt,
      });
    }

    // Rate limiting
    if (message.includes('rate limit') || message.includes('429')) {
      throw createAPICallError({
        message,
        code: 'RATE_LIMIT',
        provider,
        modelId,
        sessionId,
        promptExcerpt,
        originalMessage: message,
        isRetryable: true,
      });
    }

    // Generic error
    throw createAPICallError({
      message,
      provider,
      modelId,
      sessionId,
      promptExcerpt,
      originalMessage: message,
      isRetryable: false,
    });
  }

  // Non-Error throwables
  throw createAPICallError({
    message: String(error),
    code: 'UNKNOWN',
    provider,
    modelId,
    sessionId,
    promptExcerpt,
    isRetryable: false,
  });
}

/**
 * Checks if an error is an authentication error.
 */
export function isAuthenticationError(error: unknown): boolean {
  if (error instanceof LoadAPIKeyError) return true;
  if (error instanceof APICallError) {
    const data = error.data as PiErrorMetadata | undefined;
    return data?.code === 'AUTH_FAILED' || data?.code === '401';
  }
  return false;
}

/**
 * Checks if an error is a timeout error.
 */
export function isTimeoutError(error: unknown): boolean {
  if (error instanceof APICallError) {
    return (error.data as PiErrorMetadata)?.code === 'TIMEOUT';
  }
  return false;
}

/**
 * Checks if an error is a context overflow error.
 */
export function isContextOverflowError(error: unknown): boolean {
  if (error instanceof APICallError) {
    return (error.data as PiErrorMetadata)?.code === 'CONTEXT_OVERFLOW';
  }
  return false;
}

/**
 * Extracts Pi error metadata from an error object.
 */
export function getErrorMetadata(error: unknown): PiErrorMetadata | undefined {
  if (error instanceof APICallError && error.data) {
    return error.data as PiErrorMetadata;
  }
  return undefined;
}
