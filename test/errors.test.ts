import { APICallError, LoadAPIKeyError } from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
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
  it("creates a LoadAPIKeyError", () => {
    const error = createAuthenticationError({
      message: "Invalid API key",
      provider: "anthropic",
    });
    expect(error).toBeInstanceOf(LoadAPIKeyError);
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

  it("converts authentication errors to LoadAPIKeyError", () => {
    try {
      handlePiError(new Error("API key not found for anthropic"));
    } catch (e) {
      expect(e).toBeInstanceOf(LoadAPIKeyError);
      return;
    }
    expect.unreachable("Should have thrown");
  });

  it('converts "Unauthorized" to authentication error', () => {
    try {
      handlePiError(new Error("Unauthorized access"), { provider: "openai" });
    } catch (e) {
      expect(e).toBeInstanceOf(LoadAPIKeyError);
      return;
    }
    expect.unreachable("Should have thrown");
  });

  it('converts "401" to authentication error', () => {
    try {
      handlePiError(new Error("HTTP 401"));
    } catch (e) {
      expect(e).toBeInstanceOf(LoadAPIKeyError);
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
  it("returns true for LoadAPIKeyError", () => {
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
