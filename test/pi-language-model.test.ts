import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
  AgentSession,
  AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PiLanguageModel } from "../src/pi-language-model.js";
import type { PiLanguageModelOptions } from "../src/types.js";
import { createEmptyUsage, extractToolCallFromPartial, truncateToolResult } from "../src/stream-mapper.js";

// ─── Mock factories ───

let _mockSystemPrompt: string | undefined;

function createMockSession(): {
  session: AgentSession;
  listeners: Array<(event: AgentSessionEvent) => void>;
  promptCalls: Array<{ text: string; options?: any }>;
  abortFn: ReturnType<typeof vi.fn>;
  disposeFn: ReturnType<typeof vi.fn>;
  emitEvent: (event: AgentSessionEvent) => void;
  resolvePrompt: () => void;
  rejectPrompt: (error: Error) => void;
} {
  const listeners: Array<(event: AgentSessionEvent) => void> = [];
  const promptCalls: Array<{ text: string; options?: any }> = [];
  const abortFn = vi.fn();
  const disposeFn = vi.fn();

  let promptResolve: (() => void) | null = null;
  let promptReject: ((error: Error) => void) | null = null;

  const mockAgent = {
    state: {
      systemPrompt: "",
      messages: [],
      tools: [],
      model: null,
      thinkingLevel: "off",
    },
    waitForIdle: vi.fn(),
  };

  const session = {
    sessionId: "test-session-123",
    agent: mockAgent,
    subscribe: vi.fn((listener: (event: AgentSessionEvent) => void) => {
      listeners.push(listener);
      return () => {
        const idx = listeners.indexOf(listener);
        if (idx >= 0) {
          listeners.splice(idx, 1);
        }
      };
    }),
    prompt: vi.fn((text: string, options?: any) => {
      promptCalls.push({ text, options });
      return new Promise<void>((resolve, reject) => {
        promptResolve = resolve;
        promptReject = reject;
      });
    }),
    abort: abortFn,
    dispose: disposeFn,
  } as unknown as AgentSession;

  return {
    session,
    listeners,
    promptCalls,
    abortFn,
    disposeFn,
    emitEvent: (event: AgentSessionEvent) => {
      for (const listener of listeners) {
        listener(event);
      }
    },
    resolvePrompt: () => {
      promptResolve?.();
    },
    rejectPrompt: (error: Error) => {
      promptReject?.(error);
    },
  };
}

function createModelOptions(
  overrides?: Partial<PiLanguageModelOptions>,
): PiLanguageModelOptions {
  return {
    id: "anthropic/claude-sonnet-4",
    model: {
      id: "claude-sonnet-4",
      name: "Claude Sonnet 4",
      api: "anthropic-messages",
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com",
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
      contextWindow: 200_000,
      maxTokens: 8192,
    } as any,
    settings: {},
    providerSettings: { logger: false },
    ...overrides,
  };
}

// ─── Mock createAgentSession ───

vi.mock("@earendil-works/pi-coding-agent", () => {
  let mockSessionResult: { session: AgentSession } | null = null;

  return {
    createAgentSession: vi.fn(() => {
      if (!mockSessionResult) {
        throw new Error("No mock session configured");
      }
      return Promise.resolve(mockSessionResult);
    }),
    SessionManager: {
      inMemory: vi.fn(() => ({})),
    },
    AuthStorage: {
      create: vi.fn(() => ({})),
    },
    ModelRegistry: {
      create: vi.fn(() => ({})),
    },
    // Allow tests to set the mock session
    __setMockSession: (session: AgentSession) => {
      mockSessionResult = { session };
    },
  };
});

// Import the mocked module so we can set mock sessions
const piCodingAgent = (await import("@earendil-works/pi-coding-agent")) as any;

// ─── Tests ───

describe("PiLanguageModel", () => {
  describe("constructor", () => {
    it("creates a model with correct properties", () => {
      const options = createModelOptions();
      const model = new PiLanguageModel(options);
      expect(model.modelId).toBe("anthropic/claude-sonnet-4");
      expect(model.provider).toBe("pi");
      expect(model.specificationVersion).toBe("v3");
    });

    it("throws NoSuchModelError for empty model ID", () => {
      const options = createModelOptions({ id: "" });
      expect(() => new PiLanguageModel(options)).toThrow();
    });
  });

  describe("doGenerate", () => {
    let mockSession: ReturnType<typeof createMockSession>;

    beforeEach(() => {
      mockSession = createMockSession();
      piCodingAgent.__setMockSession(mockSession.session);
    });

    it("returns text content from agent response", async () => {
      const model = new PiLanguageModel(createModelOptions());
      const generatePromise = model.doGenerate({
        prompt: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
      });

      // Wait for session to be created and prompt called
      await vi.waitFor(() => expect(mockSession.promptCalls.length).toBe(1));
      expect(mockSession.promptCalls[0].text).toBe("Hello");

      // Simulate Pi events
      mockSession.emitEvent({
        type: "message_update",
        message: {} as any,
        assistantMessageEvent: {
          type: "text_delta",
          contentIndex: 0,
          delta: "Hi there!",
          partial: {} as any,
        },
      });

      mockSession.emitEvent({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Hi there!" }],
          api: "anthropic-messages",
          provider: "anthropic",
          model: "claude-sonnet-4",
          usage: {
            input: 100,
            output: 10,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 110,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          },
          stopReason: "end_turn",
          timestamp: Date.now(),
        } as AssistantMessage,
      });

      mockSession.resolvePrompt();

      mockSession.emitEvent({
        type: "agent_end",
        messages: [],
        willRetry: false,
      });

      const result = await generatePromise;
      expect(result.content).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "text", text: "Hi there!" }),
        ]),
      );
      expect(result.finishReason.unified).toBe("stop");
      expect(result.usage.inputTokens.total).toBe(100);
      expect(result.usage.outputTokens.total).toBe(10);
    });

    it("returns reasoning content from thinking", async () => {
      const model = new PiLanguageModel(createModelOptions());
      const generatePromise = model.doGenerate({
        prompt: [{ role: "user", content: [{ type: "text", text: "Think" }] }],
      });

      await vi.waitFor(() => expect(mockSession.promptCalls.length).toBe(1));

      mockSession.emitEvent({
        type: "message_update",
        message: {} as any,
        assistantMessageEvent: {
          type: "thinking_delta",
          contentIndex: 0,
          delta: "Let me think...",
          partial: {} as any,
        },
      });

      mockSession.emitEvent({
        type: "message_update",
        message: {} as any,
        assistantMessageEvent: {
          type: "text_delta",
          contentIndex: 1,
          delta: "My answer",
          partial: {} as any,
        },
      });

      mockSession.emitEvent({
        type: "message_end",
        message: {
          role: "assistant",
          content: [],
          api: "anthropic-messages",
          provider: "anthropic",
          model: "claude-sonnet-4",
          usage: {
            input: 50,
            output: 20,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 70,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          },
          stopReason: "stop",
          timestamp: Date.now(),
        } as AssistantMessage,
      });

      mockSession.resolvePrompt();

      mockSession.emitEvent({
        type: "agent_end",
        messages: [],
        willRetry: false,
      });

      const result = await generatePromise;
      expect(result.content).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "reasoning",
            text: "Let me think...",
          }),
          expect.objectContaining({ type: "text", text: "My answer" }),
        ]),
      );
    });

    it("returns tool call content", async () => {
      const model = new PiLanguageModel(createModelOptions());
      const generatePromise = model.doGenerate({
        prompt: [
          { role: "user", content: [{ type: "text", text: "Read a file" }] },
        ],
      });

      await vi.waitFor(() => expect(mockSession.promptCalls.length).toBe(1));

      mockSession.emitEvent({
        type: "message_update",
        message: {} as any,
        assistantMessageEvent: {
          type: "toolcall_end",
          contentIndex: 0,
          toolCall: {
            id: "tc_1",
            name: "read",
            arguments: { path: "/tmp/test.txt" },
          },
          partial: {} as any,
        },
      });

      mockSession.emitEvent({
        type: "message_end",
        message: {
          role: "assistant",
          content: [],
          api: "anthropic-messages",
          provider: "anthropic",
          model: "claude-sonnet-4",
          usage: {
            input: 100,
            output: 30,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 130,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          },
          stopReason: "toolUse",
          timestamp: Date.now(),
        } as AssistantMessage,
      });

      mockSession.resolvePrompt();

      mockSession.emitEvent({
        type: "agent_end",
        messages: [],
        willRetry: false,
      });

      const result = await generatePromise;
      expect(result.content).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "tool-call",
            toolCallId: "tc_1",
            toolName: "read",
          }),
        ]),
      );
      expect(result.finishReason.unified).toBe("tool-calls");
    });

    it("passes system prompt to Pi session", async () => {
      const model = new PiLanguageModel(createModelOptions());
      const generatePromise = model.doGenerate({
        prompt: [
          { role: "system", content: "You are a test assistant." },
          { role: "user", content: [{ type: "text", text: "Hello" }] },
        ],
      });

      await vi.waitFor(() => expect(mockSession.promptCalls.length).toBe(1));

      // Verify system prompt was passed to session
      expect(mockSession.session.agent.state.systemPrompt).toBe(
        "You are a test assistant.",
      );

      mockSession.emitEvent({
        type: "message_end",
        message: {
          role: "assistant",
          content: [],
          api: "anthropic-messages",
          provider: "anthropic",
          model: "claude-sonnet-4",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          },
          stopReason: "stop",
          timestamp: Date.now(),
        } as AssistantMessage,
      });

      mockSession.resolvePrompt();

      mockSession.emitEvent({
        type: "agent_end",
        messages: [],
        willRetry: false,
      });

      await generatePromise;
    });

    it("includes responseModel and responseId in providerMetadata", async () => {
      const model = new PiLanguageModel(createModelOptions());
      const generatePromise = model.doGenerate({
        prompt: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
      });

      await vi.waitFor(() => expect(mockSession.promptCalls.length).toBe(1));

      mockSession.emitEvent({
        type: "message_end",
        message: {
          role: "assistant",
          content: [],
          api: "anthropic-messages",
          provider: "anthropic",
          model: "claude-sonnet-4",
          responseModel: "claude-sonnet-4-20250514",
          responseId: "resp_abc123",
          usage: {
            input: 10,
            output: 5,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 15,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          },
          stopReason: "stop",
          timestamp: Date.now(),
        } as AssistantMessage,
      });

      mockSession.resolvePrompt();

      mockSession.emitEvent({
        type: "agent_end",
        messages: [],
        willRetry: false,
      });

      const result = await generatePromise;
      const providerMeta = result.providerMetadata;
      expect(providerMeta).toBeDefined();
      // Primitive values are wrapped in { value: string } by toProviderMetadata()
      expect(providerMeta?.responseModel).toEqual({
        value: "claude-sonnet-4-20250514",
      });
      expect(providerMeta?.responseId).toEqual({ value: "resp_abc123" });
    });

    it("reports warnings for unsupported parameters", async () => {
      const model = new PiLanguageModel(createModelOptions());
      const generatePromise = model.doGenerate({
        prompt: [{ role: "user", content: [{ type: "text", text: "Test" }] }],
        temperature: 0.5,
        topP: 0.9,
      });

      await vi.waitFor(() => expect(mockSession.promptCalls.length).toBe(1));

      mockSession.emitEvent({
        type: "message_end",
        message: {
          role: "assistant",
          content: [],
          api: "anthropic-messages",
          provider: "anthropic",
          model: "claude-sonnet-4",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          },
          stopReason: "stop",
          timestamp: Date.now(),
        } as AssistantMessage,
      });

      mockSession.resolvePrompt();

      mockSession.emitEvent({
        type: "agent_end",
        messages: [],
        willRetry: false,
      });

      const result = await generatePromise;
      const unsupportedWarnings = result.warnings.filter(
        (w) => w.type === "unsupported",
      );
      expect(unsupportedWarnings.length).toBe(2);
    });
  });

  describe("doStream", () => {
    let mockSession: ReturnType<typeof createMockSession>;

    beforeEach(() => {
      mockSession = createMockSession();
      piCodingAgent.__setMockSession(mockSession.session);
    });

    it("streams text deltas", async () => {
      const model = new PiLanguageModel(createModelOptions());
      const { stream: rawStream } = await model.doStream({
        prompt: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
      });

      await vi.waitFor(() => expect(mockSession.promptCalls.length).toBe(1));

      // Simulate streaming events
      mockSession.emitEvent({
        type: "message_update",
        message: {} as any,
        assistantMessageEvent: {
          type: "text_start",
          contentIndex: 0,
          partial: {} as any,
        },
      });

      mockSession.emitEvent({
        type: "message_update",
        message: {} as any,
        assistantMessageEvent: {
          type: "text_delta",
          contentIndex: 0,
          delta: "Hi ",
          partial: {} as any,
        },
      });

      mockSession.emitEvent({
        type: "message_update",
        message: {} as any,
        assistantMessageEvent: {
          type: "text_delta",
          contentIndex: 0,
          delta: "there!",
          partial: {} as any,
        },
      });

      mockSession.emitEvent({
        type: "message_update",
        message: {} as any,
        assistantMessageEvent: {
          type: "text_end",
          contentIndex: 0,
          content: "Hi there!",
          partial: {} as any,
        },
      });

      mockSession.emitEvent({
        type: "message_end",
        message: {
          role: "assistant",
          content: [],
          api: "anthropic-messages",
          provider: "anthropic",
          model: "claude-sonnet-4",
          usage: {
            input: 100,
            output: 5,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 105,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          },
          stopReason: "stop",
          timestamp: Date.now(),
        } as AssistantMessage,
      });

      mockSession.resolvePrompt();

      mockSession.emitEvent({
        type: "agent_end",
        messages: [],
        willRetry: false,
      });

      // Read the stream
      const reader = rawStream.getReader();
      const parts: any[] = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        parts.push(value);
      }

      // Should have: text-start, text-delta, text-delta, text-end, finish
      const textDeltas = parts.filter((p) => p.type === "text-delta");
      expect(textDeltas.length).toBe(2);
      expect(textDeltas[0].delta).toBe("Hi ");
      expect(textDeltas[1].delta).toBe("there!");

      const finishPart = parts.find((p) => p.type === "finish");
      expect(finishPart).toBeDefined();
      expect(finishPart.finishReason.unified).toBe("stop");
    });

    it("streams reasoning deltas", async () => {
      const model = new PiLanguageModel(createModelOptions());
      const { stream: rawStream } = await model.doStream({
        prompt: [{ role: "user", content: [{ type: "text", text: "Think" }] }],
      });

      await vi.waitFor(() => expect(mockSession.promptCalls.length).toBe(1));

      mockSession.emitEvent({
        type: "message_update",
        message: {} as any,
        assistantMessageEvent: {
          type: "thinking_start",
          contentIndex: 0,
          partial: {} as any,
        },
      });

      mockSession.emitEvent({
        type: "message_update",
        message: {} as any,
        assistantMessageEvent: {
          type: "thinking_delta",
          contentIndex: 0,
          delta: "Hmm...",
          partial: {} as any,
        },
      });

      mockSession.emitEvent({
        type: "message_update",
        message: {} as any,
        assistantMessageEvent: {
          type: "thinking_end",
          contentIndex: 0,
          content: "Hmm...",
          partial: {} as any,
        },
      });

      mockSession.emitEvent({
        type: "message_end",
        message: {
          role: "assistant",
          content: [],
          api: "anthropic-messages",
          provider: "anthropic",
          model: "claude-sonnet-4",
          usage: {
            input: 50,
            output: 10,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 60,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          },
          stopReason: "stop",
          timestamp: Date.now(),
        } as AssistantMessage,
      });

      mockSession.resolvePrompt();

      mockSession.emitEvent({
        type: "agent_end",
        messages: [],
        willRetry: false,
      });

      const reader = rawStream.getReader();
      const parts: any[] = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        parts.push(value);
      }

      const reasoningDeltas = parts.filter((p) => p.type === "reasoning-delta");
      expect(reasoningDeltas.length).toBe(1);
      expect(reasoningDeltas[0].delta).toBe("Hmm...");
    });
  });

  describe("system prompt in doStream", () => {
    let mockSession: ReturnType<typeof createMockSession>;

    beforeEach(() => {
      mockSession = createMockSession();
      piCodingAgent.__setMockSession(mockSession.session);
    });

    it("passes system prompt to Pi session in stream mode", async () => {
      const model = new PiLanguageModel(createModelOptions());
      const { stream: rawStream } = await model.doStream({
        prompt: [
          { role: "system", content: "You are a helpful stream assistant." },
          { role: "user", content: [{ type: "text", text: "Hello" }] },
        ],
      });

      await vi.waitFor(() => expect(mockSession.promptCalls.length).toBe(1));

      // Verify system prompt was passed
      expect(mockSession.session.agent.state.systemPrompt).toBe(
        "You are a helpful stream assistant.",
      );

      mockSession.emitEvent({
        type: "message_end",
        message: {
          role: "assistant",
          content: [],
          api: "anthropic-messages",
          provider: "anthropic",
          model: "claude-sonnet-4",
          responseModel: "claude-sonnet-4-20250514",
          responseId: "resp_stream_123",
          usage: {
            input: 10,
            output: 5,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 15,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          },
          stopReason: "stop",
          timestamp: Date.now(),
        } as AssistantMessage,
      });

      mockSession.resolvePrompt();

      mockSession.emitEvent({
        type: "agent_end",
        messages: [],
        willRetry: false,
      });

      // Read the stream to completion
      const reader = rawStream.getReader();
      const parts: any[] = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        parts.push(value);
      }

      const finishPart = parts.find((p) => p.type === "finish");
      expect(finishPart).toBeDefined();
      // Primitive values are wrapped in { value: string } by toProviderMetadata()
      expect(finishPart.providerMetadata?.responseModel).toEqual({
        value: "claude-sonnet-4-20250514",
      });
      expect(finishPart.providerMetadata?.responseId).toEqual({
        value: "resp_stream_123",
      });
    });
  });

  describe("dispose", () => {
    let mockSession: ReturnType<typeof createMockSession>;

    beforeEach(() => {
      mockSession = createMockSession();
      piCodingAgent.__setMockSession(mockSession.session);
    });

    it("calls session.dispose() and clears session", () => {
      const model = new PiLanguageModel(createModelOptions());

      // Force session creation
      (model as any).session = mockSession.session;
      (model as any).sessionId = "test-session-123";

      model.dispose();

      expect(mockSession.disposeFn).toHaveBeenCalledOnce();
      expect((model as any).session).toBeNull();
      expect((model as any).sessionId).toBeUndefined();
    });

    it("is safe to call multiple times", () => {
      const model = new PiLanguageModel(createModelOptions());
      (model as any).session = mockSession.session;
      model.dispose();
      model.dispose();
      expect(mockSession.disposeFn).toHaveBeenCalledOnce();
    });
    it("is safe to call when no session exists", () => {
      const model = new PiLanguageModel(createModelOptions());
      expect(() => model.dispose()).not.toThrow();
    });
  });

  describe("session reuse", () => {
    let mockSession: ReturnType<typeof createMockSession>;

    beforeEach(() => {
      mockSession = createMockSession();
      piCodingAgent.__setMockSession(mockSession.session);
    });

    it("reuses session across calls", async () => {
      const model = new PiLanguageModel(createModelOptions());

      // First call creates session
      const promise1 = model.doGenerate({
        prompt: [{ role: "user", content: [{ type: "text", text: "First" }] }],
      });

      await vi.waitFor(() => expect(mockSession.promptCalls.length).toBe(1));

      mockSession.emitEvent({
        type: "message_end",
        message: {
          role: "assistant",
          content: [],
          api: "anthropic-messages",
          provider: "anthropic",
          model: "claude-sonnet-4",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          },
          stopReason: "stop",
          timestamp: Date.now(),
        } as AssistantMessage,
      });

      mockSession.resolvePrompt();

      mockSession.emitEvent({
        type: "agent_end",
        messages: [],
        willRetry: false,
      });

      await promise1;

      // Second call should reuse session
      const promise2 = model.doGenerate({
        prompt: [{ role: "user", content: [{ type: "text", text: "Second" }] }],
      });

      await vi.waitFor(() => expect(mockSession.promptCalls.length).toBe(2));

      // Verify session reuse: the second call should use the same session
      // (subscribe called twice total, once per prompt)
      expect(mockSession.session.subscribe).toHaveBeenCalledTimes(2);

      // Clean up second call
      mockSession.emitEvent({
        type: "message_end",
        message: {
          role: "assistant",
          content: [],
          api: "anthropic-messages",
          provider: "anthropic",
          model: "claude-sonnet-4",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          },
          stopReason: "stop",
          timestamp: Date.now(),
        } as AssistantMessage,
      });

      mockSession.resolvePrompt();

      mockSession.emitEvent({
        type: "agent_end",
        messages: [],
        willRetry: false,
      });

      await promise2;
    });

    it("creates new session after prompt error (invalidation)", async () => {
      const model = new PiLanguageModel(createModelOptions());

      // First call triggers prompt error
      const promise1 = model.doGenerate({
        prompt: [{ role: "user", content: [{ type: "text", text: "First" }] }],
      });

      await vi.waitFor(() => expect(mockSession.promptCalls.length).toBe(1));

      // Simulate prompt failure
      mockSession.rejectPrompt(new Error("Prompt failed"));

      // Wait for rejection with proper error handling
      await expect(promise1).rejects.toThrow();

      // After invalidation, the old session should be cleared
      expect((model as any).session).toBeNull();
      expect((model as any).sessionId).toBeUndefined();

      // Create a new mock session for the second call
      const newMockSession = createMockSession();
      piCodingAgent.__setMockSession(newMockSession.session);

      // Second call should create a fresh session
      const promise2 = model.doGenerate({
        prompt: [{ role: "user", content: [{ type: "text", text: "Second" }] }],
      });

      // Wait for prompt call on the NEW session
      await vi.waitFor(() => expect(newMockSession.promptCalls.length).toBe(1));

      // Clean up
      newMockSession.emitEvent({
        type: "message_end",
        message: {
          role: "assistant",
          content: [],
          api: "anthropic-messages",
          provider: "anthropic",
          model: "claude-sonnet-4",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          },
          stopReason: "stop",
          timestamp: Date.now(),
        } as AssistantMessage,
      });

      newMockSession.resolvePrompt();

      newMockSession.emitEvent({
        type: "agent_end",
        messages: [],
        willRetry: false,
      });

      await promise2;
    });
  });

  describe("truncateJsonValue", () => {
    it("returns full result when below max size", () => {
      const model = new PiLanguageModel(createModelOptions());
      const result = truncateToolResult("short result", 10_000);
      expect(result).toBe("short result");
    });

    it("truncates result exceeding max size", () => {
      const model = new PiLanguageModel(createModelOptions());
      const longText = "a".repeat(15_000);
      const result = truncateToolResult(longText, 10_000);
      expect(result.length).toBeLessThan(longText.length);
      expect(result).toContain("[truncated");
      expect(result).toContain("chars]");
    });

    it("respects custom maxToolResultSize", () => {
      const longText = "a".repeat(100);
      const result = truncateToolResult(longText, 50);
      expect(result.length).toBeLessThanOrEqual(
        50 + "[truncated X chars]".length + 10,
      );
      expect(result).toContain("[truncated");
    });
  });


  describe("abort handling in doGenerate", () => {
    let mockSession: ReturnType<typeof createMockSession>;

    beforeEach(() => {
      mockSession = createMockSession();
      piCodingAgent.__setMockSession(mockSession.session);
    });

    it("calls session.abort() when abortSignal is pre-aborted", async () => {
      const model = new PiLanguageModel(createModelOptions());
      const abortController = new AbortController();
      abortController.abort(); // pre-abort

      const generatePromise = model.doGenerate({
        prompt: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
        abortSignal: abortController.signal,
      });

      // Should fail because session creation may abort
      await expect(generatePromise).rejects.toThrow();
    });
  });

  describe("extractToolCallFromPartial", () => {
    it("returns null when partial has no content", () => {
      const model = new PiLanguageModel(createModelOptions());
      const result = extractToolCallFromPartial({} as any, 0, () => "test-id");
      expect(result).toBeNull();
    });

    it("returns null when content is not an array", () => {
      const model = new PiLanguageModel(createModelOptions());
      const result = extractToolCallFromPartial(
        { content: "string" } as any,
        0,
        () => "test-id",
      );
      expect(result).toBeNull();
    });

    it("returns null when content item is not a toolCall", () => {
      const model = new PiLanguageModel(createModelOptions());
      const result = extractToolCallFromPartial(
        { content: [{ type: "text", text: "hello" }] } as any,
        0,
        () => "test-id",
      );
      expect(result).toBeNull();
    });
  });

  describe("generateAllWarnings", () => {
    it("reports all unsupported parameters", () => {
      const model = new PiLanguageModel(createModelOptions());
      const warnings = (model as any).generateAllWarnings(
        {
          temperature: 0.7,
          topP: 0.9,
          topK: 40,
          presencePenalty: 0.5,
          frequencyPenalty: 0.3,
          stopSequences: ["END"],
          seed: 42,
        },
        "test prompt",
        [],
      );
      const unsupported = warnings.filter((w: any) => w.type === "unsupported");
      expect(unsupported.length).toBe(7);
    });
  });

  describe("createEmptyUsage", () => {
    it("returns a correctly structured empty usage object", () => {
      const model = new PiLanguageModel(createModelOptions());
      const usage = createEmptyUsage();
      expect(usage).toHaveProperty("inputTokens");
      expect(usage).toHaveProperty("outputTokens");
      expect(usage.inputTokens.total).toBeUndefined();
      expect(usage.outputTokens.total).toBeUndefined();
    });
  });
});
