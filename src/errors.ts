import { APICallError, LoadAPIKeyError } from "@ai-sdk/provider";
import {
  getOverflowPatterns,
} from "@earendil-works/pi-ai";

// Re-export pi-ai's isContextOverflow for use on AssistantMessage objects
// in pi-language-model.ts (stream message_end events with stopReason "error").
export { isContextOverflow } from "@earendil-works/pi-ai";

// ─── Retryable policy ───────────────────────────────────────────────

/**
 * Error codes that indicate a retryable error.
 *
 * - TIMEOUT / ETIMEDOUT / ESOCKETTIMEDOUT: transient network timeouts
 * - RATE_LIMIT / 429: server-initiated rate limiting, safe to retry
 * - ECONNRESET / ECONNREFUSED: network-level transient failures
 * - EAI_AGAIN: DNS temporary failure
 */
export const RETRYABLE_CODES = new Set([
  "TIMEOUT",
  "RATE_LIMIT",
  "ETIMEDOUT",
  "ESOCKETTIMEDOUT",
  "ECONNRESET",
  "ECONNREFUSED",
  "EAI_AGAIN",
]);

/**
 * Error codes that are explicitly non-retryable.
 *
 * - ABORT: user-initiated abort — retrying would waste resources
 * - AUTH_FAILED: broken credentials won't fix themselves
 * - CONTEXT_OVERFLOW: shorter prompt required, not transient
 * - ENOTFOUND: DNS hard failure
 */
export const NON_RETRYABLE_CODES = new Set([
  "ABORT",
  "AUTH_FAILED",
  "CONTEXT_OVERFLOW",
  "ENOTFOUND",
]);

/**
 * Checks whether an error is retryable based on its code and type.
 *
 * Priority:
 * 1. If `error.isRetryable` is already set (APICallError), trust it.
 * 2. Otherwise check the error code against RETRYABLE_CODES / NON_RETRYABLE_CODES.
 * 3. Fallback: non-APICallError errors are assumed non-retryable.
 */
export function isRetryableError(error: unknown): boolean {
  if (error instanceof APICallError) {
    // APICallError has its own isRetryable flag — trust it.
    return error.isRetryable;
  }
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code && RETRYABLE_CODES.has(code)) return true;
    if (code && NON_RETRYABLE_CODES.has(code)) return false;
  }
  return false;
}

// ─── PiErrorMetadata ────────────────────────────────────────────────

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

// ─── Error factories ────────────────────────────────────────────────

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
    url: `pi://${provider ?? "unknown"}/${modelId ?? "unknown"}`,
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
  const providerHint = provider ? ` for provider "${provider}"` : "";
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
    code: "TIMEOUT",
    provider,
    modelId,
    promptExcerpt,
  };

  return new APICallError({
    message,
    isRetryable: true,
    url: `pi://${provider ?? "unknown"}/${modelId ?? "unknown"}`,
    requestBodyValues: promptExcerpt ? { prompt: promptExcerpt } : undefined,
    data: timeoutMs === undefined ? metadata : { ...metadata, timeoutMs },
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
    url: `pi://${provider ?? "unknown"}/${modelId ?? "unknown"}`,
    requestBodyValues: promptExcerpt ? { prompt: promptExcerpt } : undefined,
    data: {
      code: "CONTEXT_OVERFLOW",
      provider,
      modelId,
      promptExcerpt,
    } satisfies PiErrorMetadata,
  });
}

/**
 * Creates an abort error for user-initiated cancellations.
 * Abort errors are never retryable — the user asked to cancel.
 */
export function createAbortError({
  message,
  provider,
  modelId,
  sessionId,
}: {
  message: string;
  provider?: string;
  modelId?: string;
  sessionId?: string;
}): APICallError {
  return new APICallError({
    message: message || "The operation was aborted.",
    isRetryable: false,
    url: `pi://${provider ?? "unknown"}/${modelId ?? "unknown"}`,
    requestBodyValues: undefined,
    data: {
      code: "ABORT",
      provider,
      modelId,
      sessionId,
      originalMessage: message,
    } satisfies PiErrorMetadata,
  });
}

// ─── Error classification (structural-first) ────────────────────────

/**
 * Handles errors from Pi SDK operations, converting them to AI SDK errors.
 *
 * Classification order (structural-first, message as fallback):
 *
 * ┌──────────────────────────────────────────────────────────────────┐
 * │ 1. Already AI SDK error?    → re-throw as-is                    │
 * │ 2. Error instance?                                              │
 * │    a. name === "AbortError" → ABORT, non-retryable              │
 * │    b. code === "ABORT_ERR"  → ABORT, non-retryable              │
 * │    c. statusCode (HTTP)     → classified by status              │
 * │    d. error.code (Node.js)  → classified by code                │
 * │    e. message substrings    → pi-ai patterns + fallbacks        │
 * │    f. Generic               → APICallError, non-retryable       │
 * │ 3. Non-Error throwables     → UNKNOWN, non-retryable            │
 * └──────────────────────────────────────────────────────────────────┘
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
  } = {},
): never {
  // Already an AI SDK error — re-throw as-is
  if (error instanceof APICallError || error instanceof LoadAPIKeyError) {
    throw error;
  }

  // Standard Error with message
  if (error instanceof Error) {
    const message = error.message;
    const err = error as NodeJS.ErrnoException;

    // ── Structural checks (no message inspection) ──

    // Abort: name-based (DOMException, AbortError)
    if (error.name === "AbortError") {
      throw createAbortError({
        message: message || "The operation was aborted.",
        provider,
        modelId,
        sessionId,
      });
    }

    // Abort: code-based (ABORT_ERR is the DOMException code for abort)
    if (err.code === "ABORT_ERR") {
      throw createAbortError({
        message: message || "The operation was aborted.",
        provider,
        modelId,
        sessionId,
      });
    }

    // HTTP status code (some Pi SDK errors carry a statusCode/status property)
    const statusCode = (err as unknown as Record<string, unknown>).statusCode ?? (err as unknown as Record<string, unknown>).status;
    if (typeof statusCode === "number") {
      if (statusCode === 401 || statusCode === 403) {
        throw createAuthenticationError({ message, provider });
      }
      if (statusCode === 429) {
        throw createAPICallError({
          message,
          code: "RATE_LIMIT",
          provider,
          modelId,
          sessionId,
          promptExcerpt,
          originalMessage: message,
          isRetryable: true,
        });
      }
      if (statusCode === 408) {
        throw createTimeoutError({
          message,
          provider,
          modelId,
          promptExcerpt,
        });
      }
      if (statusCode >= 500) {
        throw createAPICallError({
          message,
          code: String(statusCode),
          provider,
          modelId,
          sessionId,
          promptExcerpt,
          originalMessage: message,
          isRetryable: true,
        });
      }
      // Other 4xx — non-retryable
      if (statusCode >= 400) {
        throw createAPICallError({
          message,
          code: String(statusCode),
          provider,
          modelId,
          sessionId,
          promptExcerpt,
          originalMessage: message,
          isRetryable: false,
        });
      }
    }

    // Node.js error codes (errno codes)
    if (typeof err.code === "string") {
      // Timeout codes
      if (
        err.code === "ETIMEDOUT" ||
        err.code === "ESOCKETTIMEDOUT" ||
        err.code === "ECONNABORTED"
      ) {
        throw createTimeoutError({
          message,
          provider,
          modelId,
          promptExcerpt,
        });
      }

      // Network transient errors — retryable
      if (
        err.code === "ECONNRESET" ||
        err.code === "ECONNREFUSED" ||
        err.code === "EAI_AGAIN"
      ) {
        throw createAPICallError({
          message,
          code: err.code,
          provider,
          modelId,
          sessionId,
          promptExcerpt,
          originalMessage: message,
          isRetryable: true,
        });
      }

      // DNS hard failure
      if (err.code === "ENOTFOUND") {
        throw createAPICallError({
          message,
          code: "ENOTFOUND",
          provider,
          modelId,
          sessionId,
          promptExcerpt,
          originalMessage: message,
          isRetryable: false,
        });
      }
    }

    // ── Message-based fallback ──

    // Authentication errors
    if (
      message.includes("API key") ||
      message.includes("authentication") ||
      message.includes("Unauthorized") ||
      message.includes("401") ||
      message.includes("auth")
    ) {
      throw createAuthenticationError({ message, provider });
    }

    // Context overflow — use pi-ai's maintained overflow patterns
    const overflowPatterns = getOverflowPatterns();
    if (overflowPatterns.some((p) => p.test(message))) {
      throw createContextOverflowError({
        message,
        provider,
        modelId,
        promptExcerpt,
      });
    }

    // Additional context overflow fallbacks not in pi-ai patterns
    if (
      message.includes("context") ||
      message.includes("token limit") ||
      message.includes("prompt is too long")
    ) {
      throw createContextOverflowError({
        message,
        provider,
        modelId,
        promptExcerpt,
      });
    }

    // Timeout (message-based)
    if (
      message.includes("timeout") ||
      message.includes("timed out") ||
      message.includes("ETIMEDOUT")
    ) {
      throw createTimeoutError({
        message,
        provider,
        modelId,
        promptExcerpt,
      });
    }

    // Rate limiting
    if (message.includes("rate limit") || message.includes("429")) {
      throw createAPICallError({
        message,
        code: "RATE_LIMIT",
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
    code: "UNKNOWN",
    provider,
    modelId,
    sessionId,
    promptExcerpt,
    isRetryable: false,
  });
}

// ─── Type guards ────────────────────────────────────────────────────

/**
 * Checks if an error is an authentication error.
 */
export function isAuthenticationError(error: unknown): boolean {
  if (error instanceof LoadAPIKeyError) {
    return true;
  }
  if (error instanceof APICallError) {
    const data = error.data as PiErrorMetadata | undefined;
    return data?.code === "AUTH_FAILED" || data?.code === "401";
  }
  return false;
}

/**
 * Checks if an error is a timeout error.
 */
export function isTimeoutError(error: unknown): boolean {
  if (error instanceof APICallError) {
    return (error.data as PiErrorMetadata)?.code === "TIMEOUT";
  }
  return false;
}

/**
 * Checks if an error is a context overflow error.
 */
export function isContextOverflowError(error: unknown): boolean {
  if (error instanceof APICallError) {
    return (error.data as PiErrorMetadata)?.code === "CONTEXT_OVERFLOW";
  }
  return false;
}

/**
 * Checks if an error is a user-initiated abort error.
 *
 * Abort errors occur when the caller cancels an operation via AbortController/AbortSignal.
 * They are never retryable — the user asked to cancel.
 */
export function isAbortError(error: unknown): boolean {
  if (error instanceof APICallError) {
    return (error.data as PiErrorMetadata)?.code === "ABORT";
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
