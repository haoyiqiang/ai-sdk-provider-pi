import { APICallError } from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import {
  createAPICallError,
  createAbortError,
  createAuthenticationError,
  createContextOverflowError,
  createTimeoutError,
  getErrorMetadata,
  handlePiError,
  isAbortError,
  isAuthenticationError,
  isContextOverflow,
  isContextOverflowError,
  isRetryableError,
  isTimeoutError,
  NON_RETRYABLE_CODES,
  RETRYABLE_CODES,
} from "../src/errors.js";
import {
  createAPICallError,
  createAuthenticationError,
  createContextOverflowError,
  createTimeoutError,
  getErrorMetadata,
  handlePiError,
  isAuthenticationError,
  isContextOverflowError,
  isTimeoutError,
} from "../src/errors.js";

describe("createAPICallError", () => {
  it("creates an APICallError with Pi metadata", () => {
    const error = createAPICallError({
      message: "Something went wrong",
      provider: "anthropic",
      modelId: "claude-sonnet-4",
      sessionId: "sess_123",
    });
    expect(error).toBeInstanceOf(APICallError);
    expect(error.message).toContain("Something went wrong");
    const data = error.data as any;
    expect(data.provider).toBe("anthropic");
    expect(data.modelId).toBe("claude-sonnet-4");
    expect(data.sessionId).toBe("sess_123");
  });

  it("creates a retryable error when specified", () => {
    const error = createAPICallError({
      message: "Rate limited",
      code: "RATE_LIMIT",
      isRetryable: true,
    });
    expect(error.isRetryable).toBe(true);
  });
});

describe("createAuthenticationError", () => {
  it("creates an APICallError with AUTH_FAILED code", () => {
    const error = createAuthenticationError({
      message: "Invalid API key",
      provider: "anthropic",
    });
    expect(error).toBeInstanceOf(APICallError);
    const data = (error as APICallError).data as any;
    expect(data.code).toBe("AUTH_FAILED");
    expect(error.isRetryable).toBe(false);
    expect(error.message).toContain("Invalid API key");
  });

  it("includes provider hint in default message", () => {
    const error = createAuthenticationError({
      message: "",
      provider: "openai",
    });
    expect(error.message).toContain("openai");
  });
});

describe("createTimeoutError", () => {
  it("creates a retryable APICallError with TIMEOUT code", () => {
    const error = createTimeoutError({
      message: "Request timed out",
      provider: "anthropic",
      modelId: "claude-sonnet-4",
      timeoutMs: 30_000,
    });
    expect(error).toBeInstanceOf(APICallError);
    expect(error.isRetryable).toBe(true);
    const data = error.data as any;
    expect(data.code).toBe("TIMEOUT");
    expect(data.timeoutMs).toBe(30_000);
  });
});

describe("createContextOverflowError", () => {
  it("creates a non-retryable APICallError with CONTEXT_OVERFLOW code", () => {
    const error = createContextOverflowError({
      message: "Context window exceeded",
      provider: "openai",
      modelId: "gpt-4o",
    });
    expect(error).toBeInstanceOf(APICallError);
    expect(error.isRetryable).toBe(false);
    const data = error.data as any;
    expect(data.code).toBe("CONTEXT_OVERFLOW");
  });
});

describe("handlePiError", () => {
  it("re-throws AI SDK errors as-is", () => {
    const original = new APICallError({
      message: "Original",
      url: "https://api.example.com",
      requestBodyValues: {},
      isRetryable: false,
    });
    expect(() => handlePiError(original)).toThrow(original);
  });

  it("converts authentication errors to APICallError with AUTH_FAILED code", () => {
    try {
      handlePiError(new Error("API key not found for anthropic"));
    } catch (e) {
      expect(e).toBeInstanceOf(APICallError);
      const data = (e as APICallError).data as any;
      expect(data.code).toBe("AUTH_FAILED");
      return;
    }
    expect.unreachable("Should have thrown");
  });

  it('converts "Unauthorized" to authentication error', () => {
    try {
      handlePiError(new Error("Unauthorized access"), { provider: "openai" });
    } catch (e) {
      expect(e).toBeInstanceOf(APICallError);
      const data = (e as APICallError).data as any;
      expect(data.code).toBe("AUTH_FAILED");
      return;
    }
    expect.unreachable("Should have thrown");
  });

  it('converts "invalid api key" to authentication error', () => {
    try {
      handlePiError(new Error("invalid api key provided"));
    } catch (e) {
      expect(e).toBeInstanceOf(APICallError);
      const data = (e as APICallError).data as any;
      expect(data.code).toBe("AUTH_FAILED");
      return;
    }
    expect.unreachable("Should have thrown");
  });

  it("converts context overflow errors", () => {
    try {
      handlePiError(new Error("prompt is too long"), {
        provider: "anthropic",
        modelId: "claude-sonnet-4",
      });
    } catch (e) {
      expect(e).toBeInstanceOf(APICallError);
      expect(isContextOverflowError(e)).toBe(true);
      return;
    }
    expect.unreachable("Should have thrown");
  });

  it("converts timeout errors", () => {
    try {
      handlePiError(new Error("Request timed out after 30s"), {
        provider: "openai",
      });
    } catch (e) {
      expect(e).toBeInstanceOf(APICallError);
      expect(isTimeoutError(e)).toBe(true);
      return;
    }
    expect.unreachable("Should have thrown");
  });

  it("converts rate limit errors to retryable APICallError", () => {
    try {
      handlePiError(new Error("rate limit exceeded"));
    } catch (e) {
      expect(e).toBeInstanceOf(APICallError);
      expect((e as APICallError).isRetryable).toBe(true);
      const data = (e as APICallError).data as any;
      expect(data.code).toBe("RATE_LIMIT");
      return;
    }
    expect.unreachable("Should have thrown");
  });

  it("converts generic errors to APICallError", () => {
    try {
      handlePiError(new Error("Something unexpected"), {
        provider: "anthropic",
        modelId: "claude-sonnet-4",
      });
    } catch (e) {
      expect(e).toBeInstanceOf(APICallError);
      expect((e as APICallError).isRetryable).toBe(false);
      return;
    }
    expect.unreachable("Should have thrown");
  });

  it("handles non-Error throwables", () => {
    try {
      handlePiError("string error");
    } catch (e) {
      expect(e).toBeInstanceOf(APICallError);
      const data = (e as APICallError).data as any;
      expect(data.code).toBe("UNKNOWN");
      return;
    }
    expect.unreachable("Should have thrown");
  });

  it("passes context info to created errors", () => {
    try {
      handlePiError(new Error("Generic error"), {
        provider: "anthropic",
        modelId: "claude-sonnet-4",
        sessionId: "sess_abc",
        promptExcerpt: "Tell me about...",
      });
    } catch (e) {
      expect(e).toBeInstanceOf(APICallError);
      const data = (e as APICallError).data as any;
      expect(data.provider).toBe("anthropic");
      expect(data.modelId).toBe("claude-sonnet-4");
      expect(data.sessionId).toBe("sess_abc");
      return;
    }
    expect.unreachable("Should have thrown");
  });
});

describe("isAuthenticationError", () => {
  it("returns true for APICallError with AUTH_FAILED code", () => {
    const error = createAuthenticationError({ message: "Auth failed" });
    expect(isAuthenticationError(error)).toBe(true);
  });

  it("returns false for other errors", () => {
    const error = createAPICallError({ message: "Something" });
    expect(isAuthenticationError(error)).toBe(false);
  });

  it("returns false for non-AI SDK errors", () => {
    expect(isAuthenticationError(new Error("Not an auth error"))).toBe(false);
  });
});

describe("isTimeoutError", () => {
  it("returns true for timeout errors", () => {
    const error = createTimeoutError({ message: "Timed out" });
    expect(isTimeoutError(error)).toBe(true);
  });

  it("returns false for non-timeout errors", () => {
    const error = createAPICallError({ message: "Something" });
    expect(isTimeoutError(error)).toBe(false);
  });
});

describe("isContextOverflowError", () => {
  it("returns true for context overflow errors", () => {
    const error = createContextOverflowError({ message: "Too long" });
    expect(isContextOverflowError(error)).toBe(true);
  });

  it("returns false for non-overflow errors", () => {
    const error = createAPICallError({ message: "Something" });
    expect(isContextOverflowError(error)).toBe(false);
  });
});

describe("getErrorMetadata", () => {
  it("extracts metadata from APICallError", () => {
    const error = createAPICallError({
      message: "Test",
      provider: "anthropic",
      modelId: "claude-sonnet-4",
      sessionId: "sess_123",
    });
    const metadata = getErrorMetadata(error);
    expect(metadata).toBeDefined();
    expect(metadata?.provider).toBe("anthropic");
    expect(metadata?.modelId).toBe("claude-sonnet-4");
  });

  it("returns undefined for non-APICallError", () => {
    expect(getErrorMetadata(new Error("Not an API error"))).toBeUndefined();
  });
});

describe("createAbortError", () => {
  it("creates a non-retryable APICallError with ABORTED code", () => {
    const error = createAbortError({
      message: "The operation was aborted.",
      provider: "anthropic",
      modelId: "claude-sonnet-4",
      sessionId: "sess_123",
    });
    expect(error).toBeInstanceOf(APICallError);
    expect(error.isRetryable).toBe(false);
    const data = error.data as any;
    expect(data.code).toBe("ABORTED");
    expect(data.provider).toBe("anthropic");
    expect(data.modelId).toBe("claude-sonnet-4");
    expect(data.sessionId).toBe("sess_123");
  });

  it("uses a default message when none provided", () => {
    const error = createAbortError({ message: "" });
    expect(error.message).toContain("aborted");
  });
});

describe("isAbortError", () => {
  it("returns true for abort errors created by createAbortError", () => {
    const error = createAbortError({ message: "Aborted" });
    expect(isAbortError(error)).toBe(true);
  });

  it("returns false for non-abort errors", () => {
    const error = createAPICallError({ message: "Something" });
    expect(isAbortError(error)).toBe(false);
  });

  it("returns false for non-AI SDK errors", () => {
    expect(isAbortError(new Error("Not an abort"))).toBe(false);
  });
});

describe("RETRYABLE_CODES and NON_RETRYABLE_CODES", () => {
  it("RETRYABLE_CODES contains expected values", () => {
    expect(RETRYABLE_CODES.has("TIMEOUT")).toBe(true);
    expect(RETRYABLE_CODES.has("RATE_LIMIT")).toBe(true);
    expect(RETRYABLE_CODES.has("ETIMEDOUT")).toBe(true);
    expect(RETRYABLE_CODES.has("ESOCKETTIMEDOUT")).toBe(true);
    expect(RETRYABLE_CODES.has("ECONNRESET")).toBe(true);
    expect(RETRYABLE_CODES.has("ECONNREFUSED")).toBe(true);
    expect(RETRYABLE_CODES.has("EAI_AGAIN")).toBe(true);
  });

  it("NON_RETRYABLE_CODES contains expected values", () => {
    expect(NON_RETRYABLE_CODES.has("ABORTED")).toBe(true);
    expect(NON_RETRYABLE_CODES.has("AUTH_FAILED")).toBe(true);
    expect(NON_RETRYABLE_CODES.has("CONTEXT_OVERFLOW")).toBe(true);
    expect(NON_RETRYABLE_CODES.has("ENOTFOUND")).toBe(true);
  });
});

describe("isRetryableError", () => {
  it("returns true for timeout errors", () => {
    const error = createTimeoutError({ message: "Timed out" });
    expect(isRetryableError(error)).toBe(true);
  });

  it("returns true for rate limit errors", () => {
    const error = createAPICallError({
      message: "Rate limited",
      code: "RATE_LIMIT",
      isRetryable: true,
    });
    expect(isRetryableError(error)).toBe(true);
  });

  it("returns false for abort errors", () => {
    const error = createAbortError({ message: "Aborted" });
    expect(isRetryableError(error)).toBe(false);
  });

  it("returns false for context overflow errors", () => {
    const error = createContextOverflowError({ message: "Too long" });
    expect(isRetryableError(error)).toBe(false);
  });

  it("returns false for generic errors", () => {
    const error = createAPICallError({ message: "Something" });
    expect(isRetryableError(error)).toBe(false);
  });

  it("returns true for Node.js transient network errors", () => {
    const transientErr = Object.assign(new Error("Connection refused"), {
      code: "ECONNREFUSED",
    });
    expect(isRetryableError(transientErr)).toBe(true);
  });

  it("returns false for non-Error values", () => {
    expect(isRetryableError("string")).toBe(false);
    expect(isRetryableError(42)).toBe(false);
  });
});

describe("handlePiError — structural classification", () => {
  describe("abort by name (AbortError/DOMException)", () => {
    it("detects AbortError by error.name", () => {
      const abortErr = new Error("The operation was aborted.");
      abortErr.name = "AbortError";
      try {
        handlePiError(abortErr, { provider: "anthropic" });
      } catch (e) {
        expect(e).toBeInstanceOf(APICallError);
        expect(isAbortError(e)).toBe(true);
        expect((e as APICallError).isRetryable).toBe(false);
        return;
      }
      expect.unreachable("Should have thrown");
    });
  });

  describe("abort by code (ABORT_ERR)", () => {
    it("detects ABORT_ERR code", () => {
      const abortErr = Object.assign(new Error("Aborted"), {
        code: "ABORT_ERR",
      });
      try {
        handlePiError(abortErr, { provider: "openai" });
      } catch (e) {
        expect(e).toBeInstanceOf(APICallError);
        expect(isAbortError(e)).toBe(true);
        expect((e as APICallError).isRetryable).toBe(false);
        return;
      }
      expect.unreachable("Should have thrown");
    });
  });

  describe("HTTP statusCode", () => {
    it("converts 401 statusCode to authentication error", () => {
      const err = Object.assign(new Error("Unauthorized"), {
        statusCode: 401,
      });
      try {
        handlePiError(err, { provider: "anthropic" });
      } catch (e) {
        expect(e).toBeInstanceOf(APICallError);
        const data = (e as APICallError).data as any;
        expect(data.code).toBe("AUTH_FAILED");
        return;
      }
      expect.unreachable("Should have thrown");
    });

    it("converts 403 statusCode to authentication error", () => {
      const err = Object.assign(new Error("Forbidden"), {
        statusCode: 403,
      });
      try {
        handlePiError(err);
      } catch (e) {
        expect(e).toBeInstanceOf(APICallError);
        const data = (e as APICallError).data as any;
        expect(data.code).toBe("AUTH_FAILED");
        return;
      }
      expect.unreachable("Should have thrown");
    });

    it("converts 429 statusCode to retryable rate limit error", () => {
      const err = Object.assign(new Error("Too Many Requests"), {
        statusCode: 429,
      });
      try {
        handlePiError(err);
      } catch (e) {
        expect(e).toBeInstanceOf(APICallError);
        expect((e as APICallError).isRetryable).toBe(true);
        expect((e.data as any).code).toBe("RATE_LIMIT");
        return;
      }
      expect.unreachable("Should have thrown");
    });

    it("converts 408 statusCode to timeout error", () => {
      const err = Object.assign(new Error("Request Timeout"), {
        statusCode: 408,
      });
      try {
        handlePiError(err);
      } catch (e) {
        expect(e).toBeInstanceOf(APICallError);
        expect(isTimeoutError(e)).toBe(true);
        expect((e as APICallError).isRetryable).toBe(true);
        return;
      }
      expect.unreachable("Should have thrown");
    });

    it("converts 500 statusCode to retryable error", () => {
      const err = Object.assign(new Error("Internal Server Error"), {
        statusCode: 500,
      });
      try {
        handlePiError(err);
      } catch (e) {
        expect(e).toBeInstanceOf(APICallError);
        expect((e as APICallError).isRetryable).toBe(true);
        return;
      }
      expect.unreachable("Should have thrown");
    });

    it("converts 503 statusCode to retryable error", () => {
      const err = Object.assign(new Error("Service Unavailable"), {
        statusCode: 503,
      });
      try {
        handlePiError(err);
      } catch (e) {
        expect(e).toBeInstanceOf(APICallError);
        expect((e as APICallError).isRetryable).toBe(true);
        return;
      }
      expect.unreachable("Should have thrown");
    });

    it("converts 400 statusCode to non-retryable error", () => {
      const err = Object.assign(new Error("Bad Request"), {
        statusCode: 400,
      });
      try {
        handlePiError(err);
      } catch (e) {
        expect(e).toBeInstanceOf(APICallError);
        expect((e as APICallError).isRetryable).toBe(false);
        return;
      }
      expect.unreachable("Should have thrown");
    });
  });

  describe("Node.js error codes", () => {
    it("converts ETIMEDOUT to timeout error", () => {
      const err = Object.assign(new Error("Connection timed out"), {
        code: "ETIMEDOUT",
      });
      try {
        handlePiError(err);
      } catch (e) {
        expect(e).toBeInstanceOf(APICallError);
        expect(isTimeoutError(e)).toBe(true);
        expect((e as APICallError).isRetryable).toBe(true);
        return;
      }
      expect.unreachable("Should have thrown");
    });

    it("converts ESOCKETTIMEDOUT to timeout error", () => {
      const err = Object.assign(new Error("Socket timeout"), {
        code: "ESOCKETTIMEDOUT",
      });
      try {
        handlePiError(err);
      } catch (e) {
        expect(e).toBeInstanceOf(APICallError);
        expect(isTimeoutError(e)).toBe(true);
        return;
      }
      expect.unreachable("Should have thrown");
    });

    it("converts ECONNRESET to retryable error", () => {
      const err = Object.assign(new Error("Connection reset"), {
        code: "ECONNRESET",
      });
      try {
        handlePiError(err);
      } catch (e) {
        expect(e).toBeInstanceOf(APICallError);
        expect((e as APICallError).isRetryable).toBe(true);
        expect((e.data as any).code).toBe("ECONNRESET");
        return;
      }
      expect.unreachable("Should have thrown");
    });

    it("converts ECONNREFUSED to retryable error", () => {
      const err = Object.assign(new Error("Connection refused"), {
        code: "ECONNREFUSED",
      });
      try {
        handlePiError(err);
      } catch (e) {
        expect(e).toBeInstanceOf(APICallError);
        expect((e as APICallError).isRetryable).toBe(true);
        return;
      }
      expect.unreachable("Should have thrown");
    });

    it("converts ENOTFOUND to non-retryable error", () => {
      const err = Object.assign(new Error("DNS lookup failed"), {
        code: "ENOTFOUND",
      });
      try {
        handlePiError(err);
      } catch (e) {
        expect(e).toBeInstanceOf(APICallError);
        expect((e as APICallError).isRetryable).toBe(false);
        expect((e.data as any).code).toBe("ENOTFOUND");
        return;
      }
      expect.unreachable("Should have thrown");
    });
  });

  describe("pi-ai overflow patterns", () => {
    it("matches Anthropic overflow pattern", () => {
      try {
        handlePiError(
          new Error("prompt is too long: 213462 tokens > 200000 maximum"),
        );
      } catch (e) {
        expect(e).toBeInstanceOf(APICallError);
        expect(isContextOverflowError(e)).toBe(true);
        return;
      }
      expect.unreachable("Should have thrown");
    });

    it("matches OpenAI overflow pattern", () => {
      try {
        handlePiError(
          new Error(
            "Your input exceeds the context window of this model",
          ),
        );
      } catch (e) {
        expect(e).toBeInstanceOf(APICallError);
        expect(isContextOverflowError(e)).toBe(true);
        return;
      }
      expect.unreachable("Should have thrown");
    });

    it("matches Google overflow pattern", () => {
      try {
        handlePiError(
          new Error(
            "The input token count exceeds the maximum",
          ),
        );
      } catch (e) {
        expect(e).toBeInstanceOf(APICallError);
        expect(isContextOverflowError(e)).toBe(true);
        return;
      }
      expect.unreachable("Should have thrown");
    });
  });
});

describe("isContextOverflow re-export", () => {
  it("is a function re-exported from pi-ai", () => {
    expect(typeof isContextOverflow).toBe("function");
  });
});
