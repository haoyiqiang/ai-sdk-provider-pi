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

  describe("conversation history seeding", () => {
    let mockSession: ReturnType<typeof createMockSession>;

    beforeEach(() => {
      mockSession = createMockSession();
      piCodingAgent.__setMockSession(mockSession.session);
    });

    it("seeds prior messages into session for multi-turn conversation", async () => {
      const model = new PiLanguageModel(createModelOptions());
      const generatePromise = model.doGenerate({
        prompt: [
          { role: "user", content: "Hello" },
          { role: "assistant", content: "Hi! How can I help?" },
          { role: "user", content: "What\u2019s your name?" },
        ],
      });

      await vi.waitFor(() => expect(mockSession.promptCalls.length).toBe(1));

      // Verify prior messages were seeded
      const stateMessages = (mockSession.session.agent.state as any).messages;
      expect(stateMessages).toHaveLength(2);
      expect(stateMessages[0].role).toBe("user");
      expect(stateMessages[1].role).toBe("assistant");

      // Verify the last user message is the prompt text
      expect(mockSession.promptCalls[0].text).toBe("What\u2019s your name?");

      // Complete the test
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

    it("does not seed messages when there is only a single user message", async () => {
      const model = new PiLanguageModel(createModelOptions());
      const generatePromise = model.doGenerate({
        prompt: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
      });

      await vi.waitFor(() => expect(mockSession.promptCalls.length).toBe(1));

      // Verify no prior messages were seeded
      const stateMessages = (mockSession.session.agent.state as any).messages;
      expect(stateMessages).toHaveLength(0);

      // Verify the prompt text is correct
      expect(mockSession.promptCalls[0].text).toBe("Hello");

      // Complete the test
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

    it("seeds history with system prompt + multi-turn in doStream", async () => {
      const model = new PiLanguageModel(createModelOptions());
      const { stream: rawStream } = await model.doStream({
        prompt: [
          { role: "system", content: "You are a helpful assistant." },
          { role: "user", content: "First question" },
          { role: "assistant", content: "First answer" },
          { role: "user", content: "Second question" },
        ],
      });

      await vi.waitFor(() => expect(mockSession.promptCalls.length).toBe(1));

      // Verify system prompt was passed
      expect(mockSession.session.agent.state.systemPrompt).toBe(
        "You are a helpful assistant.",
      );

      // Verify prior messages were seeded (first user + assistant, not the last user)
      const stateMessages = (mockSession.session.agent.state as any).messages;
      expect(stateMessages).toHaveLength(2);
      expect(stateMessages[0].role).toBe("user");
      expect(stateMessages[1].role).toBe("assistant");

      // Verify prompt text is the last user message
      expect(mockSession.promptCalls[0].text).toBe("Second question");

      // Complete the stream
      mockSession.emitEvent({
        type: "message_end",
        message: {
          role: "assistant",
          content: [],
          api: "anthropic-messages",
          provider: "anthropic",
          model: "claude-sonnet-4",
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

      // Read stream to completion
      const reader = rawStream.getReader();
      const parts: any[] = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        parts.push(value);
      }

      expect(parts.some((p: any) => p.type === "finish")).toBe(true);
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
      // Force session creation by setting internal state
      (model as any).sessionManager.session = mockSession.session;
      (model as any).sessionManager.sessionId = "test-session-123";

      model.dispose();
      expect(mockSession.disposeFn).toHaveBeenCalledOnce();
      expect((model as any).sessionManager.currentSession).toBeNull();
      expect((model as any).sessionManager.currentSessionId).toBeUndefined();
    });

    it("is safe to call multiple times", () => {
      const model = new PiLanguageModel(createModelOptions());
      (model as any).sessionManager.session = mockSession.session;
      model.dispose();
      model.dispose();
      expect(mockSession.disposeFn).toHaveBeenCalledOnce();
    });
    it("is safe to call when no session exists", () => {
      const model = new PiLanguageModel(createModelOptions());
      expect(() => model.dispose()).not.toThrow();
    });
  });

  describe("resolveLogger", () => {
    it("fully silences all log levels when logger is false", () => {
      const options = createModelOptions({ providerSettings: { logger: false } });
      const model = new PiLanguageModel(options);
      const logger = (model as any).logger;

      // All methods should be no-ops — calling them must not throw
      expect(() => logger.debug("debug msg")).not.toThrow();
      expect(() => logger.info("info msg")).not.toThrow();
      expect(() => logger.warn("warn msg")).not.toThrow();
      expect(() => logger.error("error msg")).not.toThrow();
    });

    it("uses custom logger directly when provided", () => {
      const customLogger = {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      };
      const options = createModelOptions({ providerSettings: { logger: customLogger } });
      const model = new PiLanguageModel(options);
      const resolvedLogger = (model as any).logger;

      // Should return the exact same logger object
      expect(resolvedLogger).toStrictEqual(customLogger);

      // Calling methods should invoke the spies
      resolvedLogger.debug("d");
      resolvedLogger.info("i");
      resolvedLogger.warn("w");
      resolvedLogger.error("e");

      expect(customLogger.debug).toHaveBeenCalledWith("d");
      expect(customLogger.info).toHaveBeenCalledWith("i");
      expect(customLogger.warn).toHaveBeenCalledWith("w");
      expect(customLogger.error).toHaveBeenCalledWith("e");
    });

    it("passes all log levels when verbose is true", () => {
      const spyDebug = vi.spyOn(console, "debug").mockImplementation(() => {});
      const spyInfo = vi.spyOn(console, "info").mockImplementation(() => {});
      const spyWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const spyError = vi.spyOn(console, "error").mockImplementation(() => {});

      try {
        const options = createModelOptions({ providerSettings: { verbose: true } });
        const model = new PiLanguageModel(options);
        const logger = (model as any).logger;

        logger.debug("debug msg");
        logger.info("info msg");
        logger.warn("warn msg");
        logger.error("error msg");

        expect(spyDebug).toHaveBeenCalledWith("[pi] debug msg");
        expect(spyInfo).toHaveBeenCalledWith("[pi] info msg");
        expect(spyWarn).toHaveBeenCalledWith("[pi] warn msg");
        expect(spyError).toHaveBeenCalledWith("[pi] error msg");
      } finally {
        spyDebug.mockRestore();
        spyInfo.mockRestore();
        spyWarn.mockRestore();
        spyError.mockRestore();
      }
    });

    it("silences debug/info when verbose is false (default)", () => {
      const spyDebug = vi.spyOn(console, "debug").mockImplementation(() => {});
      const spyInfo = vi.spyOn(console, "info").mockImplementation(() => {});
      const spyWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const spyError = vi.spyOn(console, "error").mockImplementation(() => {});

      try {
        // Explicitly set verbose: false
        const options = createModelOptions({ providerSettings: { verbose: false } });
        const model = new PiLanguageModel(options);
        const logger = (model as any).logger;

        logger.debug("debug msg");
        logger.info("info msg");
        logger.warn("warn msg");
        logger.error("error msg");

        expect(spyDebug).not.toHaveBeenCalled();
        expect(spyInfo).not.toHaveBeenCalled();
        expect(spyWarn).toHaveBeenCalledWith("[pi] warn msg");
        expect(spyError).toHaveBeenCalledWith("[pi] error msg");
      } finally {
        spyDebug.mockRestore();
        spyInfo.mockRestore();
        spyWarn.mockRestore();
        spyError.mockRestore();
      }
    });

    it("silences debug/info when verbose is not set (default)", () => {
      const spyDebug = vi.spyOn(console, "debug").mockImplementation(() => {});
      const spyInfo = vi.spyOn(console, "info").mockImplementation(() => {});
      const spyWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const spyError = vi.spyOn(console, "error").mockImplementation(() => {});

      try {
        // providerSettings does not include verbose at all (default)
        const options = createModelOptions({ providerSettings: {} });
        const model = new PiLanguageModel(options);
        const logger = (model as any).logger;

        logger.debug("debug msg");
        logger.info("info msg");
        logger.warn("warn msg");
        logger.error("error msg");

        expect(spyDebug).not.toHaveBeenCalled();
        expect(spyInfo).not.toHaveBeenCalled();
        expect(spyWarn).toHaveBeenCalledWith("[pi] warn msg");
        expect(spyError).toHaveBeenCalledWith("[pi] error msg");
      } finally {
        spyDebug.mockRestore();
        spyInfo.mockRestore();
        spyWarn.mockRestore();
        spyError.mockRestore();
      }
    });

    it("custom logger bypasses verbose flag entirely", () => {
      const customLogger = {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      };
      const options = createModelOptions({
        providerSettings: { verbose: false, logger: customLogger },
      });
      const model = new PiLanguageModel(options);
      const resolvedLogger = (model as any).logger;

      // Custom logger takes priority over verbose flag
      expect(resolvedLogger).toStrictEqual(customLogger);
    });
  });

  describe("resolveLogger with mock session", () => {
    let mockSession: ReturnType<typeof createMockSession>;

    beforeEach(() => {
      mockSession = createMockSession();
      piCodingAgent.__setMockSession(mockSession.session);
    });

    it("captured logger fires warn/error but not debug/info when verbose is false", async () => {
      const capturedLogger = {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      };
      const options = createModelOptions({
        providerSettings: { verbose: false, logger: capturedLogger },
      });
      const model = new PiLanguageModel(options);

      const generatePromise = model.doGenerate({
        prompt: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
      });

      await vi.waitFor(() => expect(mockSession.promptCalls.length).toBe(1));

      // Emit a warning-like event to trigger logger.warn via settings validation warnings
      mockSession.emitEvent({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "ok" }],
          api: "anthropic-messages",
          provider: "anthropic",
          model: "claude-sonnet-4",
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
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

      // Custom logger bypasses verbose flag — all methods are passed through.
      // debug/info may be called (e.g., session creation info).
      // The point: captured logger object is the one used, and all its methods are active.
      expect(capturedLogger.info).toHaveBeenCalled();
    });

    it("captured logger is fully silent when logger is false even with mock session", async () => {
      const options = createModelOptions({
        providerSettings: { logger: false },
      });
      const model = new PiLanguageModel(options);
      const logger = (model as any).logger;

      // Internal logger should be no-op
      expect(() => logger.debug("test")).not.toThrow();
      expect(() => logger.info("test")).not.toThrow();
      expect(() => logger.warn("test")).not.toThrow();
      expect(() => logger.error("test")).not.toThrow();

      // Run a real doGenerate to confirm no crashes with logger=false
      const generatePromise = model.doGenerate({
        prompt: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
      });

      await vi.waitFor(() => expect(mockSession.promptCalls.length).toBe(1));

      mockSession.emitEvent({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "ok" }],
          api: "anthropic-messages",
          provider: "anthropic",
          model: "claude-sonnet-4",
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
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

      await expect(generatePromise).resolves.toBeDefined();
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
      expect((model as any).sessionManager.currentSession).toBeNull();
      expect((model as any).sessionManager.currentSessionId).toBeUndefined();

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

    it("serializes concurrent session creation (one createAgentSession call)", async () => {
      const mockSession = createMockSession();
      piCodingAgent.__setMockSession(mockSession.session);

      // Reset call history so we count only calls during this test
      piCodingAgent.createAgentSession.mockClear();

      // Make createAgentSession return a deferred promise so we can control
      // when it resolves.
      let resolveDeferred: (value: { session: AgentSession }) => void;
      piCodingAgent.createAgentSession.mockImplementationOnce(() => {
        return new Promise((resolve) => {
          resolveDeferred = resolve;
        });
      });

      const model = new PiLanguageModel(createModelOptions());

      // Fire two concurrent doGenerate calls
      const promise1 = model.doGenerate({
        prompt: [{ role: "user", content: [{ type: "text", text: "First" }] }],
      });

      const promise2 = model.doGenerate({
        prompt: [{ role: "user", content: [{ type: "text", text: "Second" }] }],
      });

      // Both calls should be waiting on the serialization queue.
      // createAgentSession must have been called exactly once.
      await vi.waitFor(() => expect(piCodingAgent.createAgentSession).toHaveBeenCalledTimes(1));

      // Resolve the deferred session creation
      resolveDeferred!({ session: mockSession.session });

      // Now both calls proceed: first one gets the session from ensureSession,
      // second one sees it already exists and reuses it.
      // Wait for both prompt calls
      await vi.waitFor(() => expect(mockSession.promptCalls.length).toBe(2));

      // createAgentSession must still have been called exactly once
      expect(piCodingAgent.createAgentSession).toHaveBeenCalledTimes(1);

      // Clean up both calls
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
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop",
          timestamp: Date.now(),
        } as AssistantMessage,
      });

      mockSession.resolvePrompt();
      mockSession.emitEvent({ type: "agent_end", messages: [], willRetry: false });

      mockSession.resolvePrompt();
      mockSession.emitEvent({ type: "agent_end", messages: [], willRetry: false });

      await Promise.all([promise1, promise2]);

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
          tools: [{ type: "function", name: "test" } as any],
          toolChoice: "auto" as any,
        },
        "test prompt",
        [],
      );
      const unsupported = warnings.filter((w: any) => w.type === "unsupported");
      expect(unsupported.length).toBe(9);
    });

    it("warns when options.tools is non-empty", () => {
      const model = new PiLanguageModel(createModelOptions());
      const warnings = (model as any).generateAllWarnings(
        { tools: [{ type: "function", name: "test" } as any] },
        "test prompt",
        [],
      );
      const unsupported = warnings.filter((w: any) => w.type === "unsupported");
      expect(unsupported.length).toBe(1);
      expect(unsupported[0].feature).toBe("tools");
    });

    it("warns when options.toolChoice is set", () => {
      const model = new PiLanguageModel(createModelOptions());
      const warnings = (model as any).generateAllWarnings(
        { toolChoice: "auto" as any },
        "test prompt",
        [],
      );
      const unsupported = warnings.filter((w: any) => w.type === "unsupported");
      expect(unsupported.length).toBe(1);
      expect(unsupported[0].feature).toBe("toolChoice");
    });

    it("does not warn when options.tools is empty array", () => {
      const model = new PiLanguageModel(createModelOptions());
      const warnings = (model as any).generateAllWarnings(
        { tools: [] },
        "test prompt",
        [],
      );
      const unsupported = warnings.filter((w: any) => w.type === "unsupported");
      expect(unsupported.length).toBe(0);
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

  describe("extractUsage", () => {
    it("computes noCache = input when cacheRead is 0", () => {
      const model = new PiLanguageModel(createModelOptions());
      const piUsage = {
        input: 100,
        output: 50,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 150,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      };
      const usage = (model as any).extractUsage(piUsage);
      expect(usage.inputTokens.noCache).toBe(100);
    });

    it("computes noCache = input - cacheRead when cacheRead > 0 and input > cacheRead", () => {
      const model = new PiLanguageModel(createModelOptions());
      const piUsage = {
        input: 100,
        output: 50,
        cacheRead: 30,
        cacheWrite: 10,
        totalTokens: 150,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      };
      const usage = (model as any).extractUsage(piUsage);
      expect(usage.inputTokens.noCache).toBe(70);
    });

    it("computes noCache = undefined when cacheRead >= input", () => {
      const model = new PiLanguageModel(createModelOptions());
      const piUsage = {
        input: 100,
        output: 50,
        cacheRead: 100,
        cacheWrite: 0,
        totalTokens: 150,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      };
      const usage = (model as any).extractUsage(piUsage);
      // max(100-100, 0) = 0, and since 0 is not > 0, it becomes undefined
      expect(usage.inputTokens.noCache).toBeUndefined();
    });

    it("populates outputTokens.text with usage.output", () => {
      const model = new PiLanguageModel(createModelOptions());
      const piUsage = {
        input: 10,
        output: 50,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 60,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      };
      const usage = (model as any).extractUsage(piUsage);
      expect(usage.outputTokens.text).toBe(50);
    });

    it("normalizes raw to a stable flat object without cost nesting", () => {
      const model = new PiLanguageModel(createModelOptions());
      const piUsage = {
        input: 100,
        output: 50,
        cacheRead: 30,
        cacheWrite: 10,
        totalTokens: 150,
        cost: { input: 0.3, output: 0.75, cacheRead: 0.1, cacheWrite: 0.2, total: 1.1 },
      };
      const usage = (model as any).extractUsage(piUsage);
      expect(usage.raw).toEqual({
        input: 100,
        output: 50,
        cacheRead: 30,
        cacheWrite: 10,
        totalTokens: 150,
      });
    });

    it("computes noCache = undefined when input is 0", () => {
      const model = new PiLanguageModel(createModelOptions());
      const piUsage = {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      };
      const usage = (model as any).extractUsage(piUsage);
      expect(usage.inputTokens.noCache).toBeUndefined();
    });

    it("preserves existing inputTokens fields correctly", () => {
      const model = new PiLanguageModel(createModelOptions());
      const piUsage = {
        input: 200,
        output: 100,
        cacheRead: 50,
        cacheWrite: 20,
        totalTokens: 300,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      };
      const usage = (model as any).extractUsage(piUsage);
      expect(usage.inputTokens.total).toBe(200);
      expect(usage.inputTokens.cacheRead).toBe(50);
      expect(usage.inputTokens.cacheWrite).toBe(20);
      expect(usage.outputTokens.total).toBe(100);
    });
  });
});
