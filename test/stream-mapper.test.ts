import type {
  LanguageModelV3FinishReason,
  LanguageModelV3StreamPart,
  LanguageModelV3Usage,
} from "@ai-sdk/provider";
import type {
  AssistantMessageEvent,
  Usage as PiUsage,
} from "@earendil-works/pi-ai";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it } from "vitest";
import {
  createEmptyUsage,
  extractUsage,
  mapPiEventToStreamParts,
  MAX_TOOL_RESULT_SIZE,
  toProviderMetadata,
  UNKNOWN_TOOL_NAME,
} from "../src/stream-mapper.js";
import type { StreamMapperContext } from "../src/stream-mapper.js";
import type { PiProviderMetadata } from "../src/types.js";

// ─── Helpers ───

function createCtx(
  overrides?: Partial<StreamMapperContext>,
): StreamMapperContext {
  return {
    activeTextPartId: undefined,
    activeReasoningPartId: undefined,
    toolStates: new Map(),
    piMeta: {},
    usage: createEmptyUsage(),
    finishReason: { unified: "stop", raw: undefined },
    generateId: () => `id-${Math.random().toString(36).slice(2, 8)}`,
    sessionId: "test-session",
    modelId: "test-model",
    startTime: Date.now(),
    maxToolResultSize: MAX_TOOL_RESULT_SIZE,
    toProviderMetadata,
    warnings: [],
    streamStarted: false,
    ...overrides,
  };
}

function makeMessageUpdateEvent(
  assistantMessageEvent: AssistantMessageEvent,
): AgentSessionEvent {
  return {
    type: "message_update",
    message: {} as any,
    assistantMessageEvent,
  };
}

function makeToolCall(
  id: string,
  name: string,
  args: Record<string, unknown>,
): { id: string; name: string; arguments: Record<string, unknown> } {
  return { id, name, arguments: args };
}

/** Collects all non-null stream parts from a test session. */
function collectParts(
  events: AgentSessionEvent[],
  ctx: StreamMapperContext,
): LanguageModelV3StreamPart[] {
  const allParts: LanguageModelV3StreamPart[] = [];
  for (const event of events) {
    allParts.push(...mapPiEventToStreamParts(event, ctx));
  }
  return allParts;
}

// ─── Tests ───

describe("mapPiEventToStreamParts", () => {
  let ctx: StreamMapperContext;

  beforeEach(() => {
    ctx = createCtx();
  });

  // ═══════════════════════════════════════════
  //  response-metadata on message_update start
  // ═══════════════════════════════════════════

  describe("message_update with start sub-event", () => {
    it("emits response-metadata part", () => {
      const event = makeMessageUpdateEvent({
        type: "start",
        partial: {} as any,
      });
      const parts = mapPiEventToStreamParts(event, ctx);

      expect(parts).toHaveLength(2);
      expect(parts[0].type).toBe("stream-start");
      expect(parts[1].type).toBe("response-metadata");
      const meta = parts[1] as {
        type: "response-metadata";
        id?: string;
        timestamp?: Date;
        modelId?: string;
      };
      expect(meta.id).toBe("test-session");
      expect(meta.timestamp).toBeInstanceOf(Date);
      expect(meta.modelId).toBe("test-model");
    });

    it("falls back to generated ID when sessionId is undefined", () => {
      const ctxWithoutSession = createCtx({ sessionId: undefined });
      const event = makeMessageUpdateEvent({
        type: "start",
        partial: {} as any,
      });
      const parts = mapPiEventToStreamParts(event, ctxWithoutSession);

      expect(parts).toHaveLength(2);
      expect(parts[0].type).toBe("stream-start");
      expect(parts[1].type).toBe("response-metadata");
      const meta = parts[1] as { type: "response-metadata"; id?: string };
      expect(meta.id).toBeDefined();
      expect(meta.id).not.toBe("");
    });
  });

  // ═══════════════════════════════════════════
  //  Text lifecycle
  // ═══════════════════════════════════════════

  describe("text streaming", () => {
    it("handles text_start → text_delta → text_end lifecycle", () => {
      const events: AgentSessionEvent[] = [
        makeMessageUpdateEvent({
          type: "text_start",
          contentIndex: 0,
          partial: {} as any,
        }),
        makeMessageUpdateEvent({
          type: "text_delta",
          contentIndex: 0,
          delta: "Hello ",
          partial: {} as any,
        }),
        makeMessageUpdateEvent({
          type: "text_delta",
          contentIndex: 0,
          delta: "world!",
          partial: {} as any,
        }),
        makeMessageUpdateEvent({
          type: "text_end",
          contentIndex: 0,
          content: "Hello world!",
          partial: {} as any,
        }),
      ];

      const parts = collectParts(events, ctx);

      expect(parts).toHaveLength(4);
      expect(parts[0]).toMatchObject({ type: "text-start" });
      expect(parts[1]).toMatchObject({ type: "text-delta", delta: "Hello " });
      expect(parts[2]).toMatchObject({ type: "text-delta", delta: "world!" });
      expect(parts[3]).toMatchObject({ type: "text-end" });

      // Verify same ID used throughout
      const id = (parts[0] as any).id;
      expect((parts[1] as any).id).toBe(id);
      expect((parts[2] as any).id).toBe(id);
      expect((parts[3] as any).id).toBe(id);

      // After text_end, activeTextPartId is cleared
      expect(ctx.activeTextPartId).toBeUndefined();
    });

    it("auto-creates text-start on text_delta without prior start", () => {
      const event = makeMessageUpdateEvent({
        type: "text_delta",
        contentIndex: 0,
        delta: "Hello",
        partial: {} as any,
      });

      const parts = mapPiEventToStreamParts(event, ctx);

      expect(parts).toHaveLength(2);
      expect(parts[0]).toMatchObject({ type: "text-start" });
      expect(parts[1]).toMatchObject({ type: "text-delta", delta: "Hello" });

      const id = (parts[0] as any).id;
      expect((parts[1] as any).id).toBe(id);
    });

    it("does not emit duplicate text-start on second text_start", () => {
      const events: AgentSessionEvent[] = [
        makeMessageUpdateEvent({
          type: "text_start",
          contentIndex: 0,
          partial: {} as any,
        }),
        makeMessageUpdateEvent({
          type: "text_start",
          contentIndex: 0,
          partial: {} as any,
        }),
      ];

      const parts = collectParts(events, ctx);

      // Only one text-start should be emitted
      expect(parts).toHaveLength(1);
      expect(parts[0].type).toBe("text-start");
    });

    it("ignores text_end when no text is active", () => {
      const event = makeMessageUpdateEvent({
        type: "text_end",
        contentIndex: 0,
        content: "text",
        partial: {} as any,
      });

      const parts = mapPiEventToStreamParts(event, ctx);
      expect(parts).toHaveLength(0);
    });

    it("includes providerMetadata on text parts when piMeta is populated", () => {
      ctx.piMeta = { provider: "anthropic", modelId: "claude" };
      const event = makeMessageUpdateEvent({
        type: "text_delta",
        contentIndex: 0,
        delta: "Hi",
        partial: {} as any,
      });

      const parts = mapPiEventToStreamParts(event, ctx);

      const textStart = parts.find((p) => p.type === "text-start") as any;
      expect(textStart.providerMetadata).toBeDefined();
      expect(textStart.providerMetadata.provider).toEqual({
        value: "anthropic",
      });

      const textDelta = parts.find((p) => p.type === "text-delta") as any;
      expect(textDelta.providerMetadata).toBeDefined();
    });
  });

  // ═══════════════════════════════════════════
  //  Reasoning lifecycle
  // ═══════════════════════════════════════════

  describe("reasoning streaming", () => {
    it("handles thinking_start → thinking_delta → thinking_end lifecycle", () => {
      const events: AgentSessionEvent[] = [
        makeMessageUpdateEvent({
          type: "thinking_start",
          contentIndex: 0,
          partial: {} as any,
        }),
        makeMessageUpdateEvent({
          type: "thinking_delta",
          contentIndex: 0,
          delta: "Hmm...",
          partial: {} as any,
        }),
        makeMessageUpdateEvent({
          type: "thinking_end",
          contentIndex: 0,
          content: "Hmm...",
          partial: {} as any,
        }),
      ];

      const parts = collectParts(events, ctx);

      expect(parts).toHaveLength(3);
      expect(parts[0]).toMatchObject({ type: "reasoning-start" });
      expect(parts[1]).toMatchObject({
        type: "reasoning-delta",
        delta: "Hmm...",
      });
      expect(parts[2]).toMatchObject({ type: "reasoning-end" });

      const id = (parts[0] as any).id;
      expect((parts[1] as any).id).toBe(id);
      expect((parts[2] as any).id).toBe(id);

      expect(ctx.activeReasoningPartId).toBeUndefined();
    });

    it("auto-creates reasoning-start on thinking_delta without prior start", () => {
      const event = makeMessageUpdateEvent({
        type: "thinking_delta",
        contentIndex: 0,
        delta: "Let me think",
        partial: {} as any,
      });

      const parts = mapPiEventToStreamParts(event, ctx);

      expect(parts).toHaveLength(2);
      expect(parts[0]).toMatchObject({ type: "reasoning-start" });
      expect(parts[1]).toMatchObject({
        type: "reasoning-delta",
        delta: "Let me think",
      });
    });

    it("ignores thinking_end when no reasoning is active", () => {
      const event = makeMessageUpdateEvent({
        type: "thinking_end",
        contentIndex: 0,
        content: "thought",
        partial: {} as any,
      });

      const parts = mapPiEventToStreamParts(event, ctx);
      expect(parts).toHaveLength(0);
    });
  });

  // ═══════════════════════════════════════════
  //  Tool call lifecycle (from message_update)
  // ═══════════════════════════════════════════

  describe("tool call streaming (from message_update)", () => {
    function makeToolCallPartial(
      id: string,
      name: string,
      args: Record<string, unknown>,
    ): any {
      return {
        content: [{ type: "toolCall", id, name, arguments: args }],
      };
    }

    it("handles toolcall_start → toolcall_delta → toolcall_end lifecycle", () => {
      const tcId = "tc_abc";
      const events: AgentSessionEvent[] = [
        makeMessageUpdateEvent({
          type: "toolcall_start",
          contentIndex: 0,
          partial: makeToolCallPartial(tcId, "read", {}),
        }),
        makeMessageUpdateEvent({
          type: "toolcall_delta",
          contentIndex: 0,
          delta: '{"path":',
          partial: makeToolCallPartial(tcId, "read", {}),
        }),
        makeMessageUpdateEvent({
          type: "toolcall_delta",
          contentIndex: 0,
          delta: '"/tmp/f"}',
          partial: makeToolCallPartial(tcId, "read", {}),
        }),
        makeMessageUpdateEvent({
          type: "toolcall_end",
          contentIndex: 0,
          toolCall: makeToolCall(tcId, "read", { path: "/tmp/f" }),
          partial: makeToolCallPartial(tcId, "read", {}),
        }),
      ];

      const parts = collectParts(events, ctx);

      // tool-input-start, tool-input-delta, tool-input-delta, tool-input-end, tool-call
      expect(parts).toHaveLength(5);
      expect(parts[0]).toMatchObject({
        type: "tool-input-start",
        id: tcId,
        toolName: "read",
        providerExecuted: true,
        dynamic: true,
      });
      expect(parts[1]).toMatchObject({
        type: "tool-input-delta",
        delta: '{"path":',
      });
      expect(parts[2]).toMatchObject({
        type: "tool-input-delta",
        delta: '"/tmp/f"}',
      });
      expect(parts[3]).toMatchObject({ type: "tool-input-end", id: tcId });
      expect(parts[4]).toMatchObject({
        type: "tool-call",
        toolCallId: tcId,
        toolName: "read",
        input: '{"path":"/tmp/f"}',
      });
    });

    it("auto-closes active text part on toolcall_start", () => {
      // Start text
      mapPiEventToStreamParts(
        makeMessageUpdateEvent({
          type: "text_delta",
          contentIndex: 0,
          delta: "Let me read...",
          partial: {} as any,
        }),
        ctx,
      );
      expect(ctx.activeTextPartId).toBeDefined();

      // toolcall_start should close text
      const tcId = "tc_1";
      const event = makeMessageUpdateEvent({
        type: "toolcall_start",
        contentIndex: 0,
        partial: makeToolCallPartial(tcId, "read", {}),
      });

      const parts = mapPiEventToStreamParts(event, ctx);

      const textEndPart = parts.find((p) => p.type === "text-end");
      expect(textEndPart).toBeDefined();
      expect(ctx.activeTextPartId).toBeUndefined();

      const toolStartPart = parts.find((p) => p.type === "tool-input-start");
      expect(toolStartPart).toBeDefined();
    });

    it("skips toolcall_start when partial doesn't contain a toolCall", () => {
      const event = makeMessageUpdateEvent({
        type: "toolcall_start",
        contentIndex: 0,
        partial: { content: [{ type: "text", text: "not a tool" }] } as any,
      });

      const parts = mapPiEventToStreamParts(event, ctx);

      // No parts emitted
      expect(parts).toHaveLength(0);
    });

    it("uses default name when toolCall has no name", () => {
      const tcId = "tc_no_name";
      const event = makeMessageUpdateEvent({
        type: "toolcall_start",
        contentIndex: 0,
        partial: {
          content: [{ type: "toolCall", id: tcId, arguments: {} }],
        } as any,
      });

      const parts = mapPiEventToStreamParts(event, ctx);
      const startPart = parts.find((p) => p.type === "tool-input-start") as any;
      expect(startPart.toolName).toBe(UNKNOWN_TOOL_NAME);
    });

    it("stringifies tool call arguments that are objects", () => {
      const tcId = "tc_obj";
      const events: AgentSessionEvent[] = [
        makeMessageUpdateEvent({
          type: "toolcall_start",
          contentIndex: 0,
          partial: makeToolCallPartial(tcId, "bash", {}),
        }),
        makeMessageUpdateEvent({
          type: "toolcall_end",
          contentIndex: 0,
          toolCall: makeToolCall(tcId, "bash", { command: "ls" }),
          partial: makeToolCallPartial(tcId, "bash", {}),
        }),
      ];

      const parts = collectParts(events, ctx);
      const callPart = parts.find((p) => p.type === "tool-call") as any;
      expect(callPart.input).toBe('{"command":"ls"}');
    });

    it("passes string arguments through without re-stringifying", () => {
      const tcId = "tc_str";
      const events: AgentSessionEvent[] = [
        makeMessageUpdateEvent({
          type: "toolcall_start",
          contentIndex: 0,
          partial: makeToolCallPartial(tcId, "read", {}),
        }),
        makeMessageUpdateEvent({
          type: "toolcall_end",
          contentIndex: 0,
          toolCall: makeToolCall(tcId, "read", "already a string"),
          partial: makeToolCallPartial(tcId, "read", {}),
        }),
      ];

      const parts = collectParts(events, ctx);
      const callPart = parts.find((p) => p.type === "tool-call") as any;
      expect(callPart.input).toBe("already a string");
    });

    it("accumulates tool input across deltas", () => {
      const tcId = "tc_accum";
      const events: AgentSessionEvent[] = [
        makeMessageUpdateEvent({
          type: "toolcall_start",
          contentIndex: 0,
          partial: makeToolCallPartial(tcId, "write", {}),
        }),
        makeMessageUpdateEvent({
          type: "toolcall_delta",
          contentIndex: 0,
          delta: "part1",
          partial: makeToolCallPartial(tcId, "write", {}),
        }),
        makeMessageUpdateEvent({
          type: "toolcall_delta",
          contentIndex: 0,
          delta: "part2",
          partial: makeToolCallPartial(tcId, "write", {}),
        }),
      ];

      collectParts(events, ctx);

      const state = ctx.toolStates.get(tcId);
      expect(state).toBeDefined();
      expect(state!.inputAccumulator).toBe("part1part2");
    });
  });

  // ═══════════════════════════════════════════
  //  tool_execution_start / tool_execution_end
  // ═══════════════════════════════════════════

  describe("tool_execution_start", () => {
    it("emits tool-input-start for new tool", () => {
      const event: AgentSessionEvent = {
        type: "tool_execution_start",
        toolCallId: "tc_exec_1",
        toolName: "bash",
        args: { command: "ls" },
      };

      const parts = mapPiEventToStreamParts(event, ctx);

      expect(parts).toHaveLength(1);
      expect(parts[0]).toMatchObject({
        type: "tool-input-start",
        id: "tc_exec_1",
        toolName: "bash",
        providerExecuted: true,
        dynamic: true,
      });

      expect(ctx.toolStates.has("tc_exec_1")).toBe(true);
    });

    it("does not emit duplicate tool-input-start for already-tracked tool", () => {
      ctx.toolStates.set("tc_existing", {
        toolCallId: "tc_existing",
        toolName: "read",
        args: {},
        startTime: Date.now(),
        inputAccumulator: "",
        hasEmittedStart: true,
      });

      const event: AgentSessionEvent = {
        type: "tool_execution_start",
        toolCallId: "tc_existing",
        toolName: "read",
        args: {},
      };

      const parts = mapPiEventToStreamParts(event, ctx);
      expect(parts).toHaveLength(0);
    });
  });

  describe("tool_execution_end", () => {
    it("emits tool-result and removes from toolStates", () => {
      ctx.toolStates.set("tc_exec_end", {
        toolCallId: "tc_exec_end",
        toolName: "grep",
        args: {},
        startTime: Date.now(),
        inputAccumulator: "",
        hasEmittedStart: true,
      });

      const event: AgentSessionEvent = {
        type: "tool_execution_end",
        toolCallId: "tc_exec_end",
        toolName: "grep",
        result: "found 3 matches",
        isError: false,
      };

      const parts = mapPiEventToStreamParts(event, ctx);

      expect(parts).toHaveLength(1);
      expect(parts[0]).toMatchObject({
        type: "tool-result",
        toolCallId: "tc_exec_end",
        toolName: "grep",
        result: "found 3 matches",
        dynamic: true,
      });
      expect((parts[0] as any).isError).toBeUndefined();

      expect(ctx.toolStates.has("tc_exec_end")).toBe(false);
    });

    it("sets isError: true on error result", () => {
      ctx.toolStates.set("tc_err", {
        toolCallId: "tc_err",
        toolName: "bash",
        args: {},
        startTime: Date.now(),
        inputAccumulator: "",
        hasEmittedStart: true,
      });

      const event: AgentSessionEvent = {
        type: "tool_execution_end",
        toolCallId: "tc_err",
        toolName: "bash",
        result: "command not found",
        isError: true,
      };

      const parts = mapPiEventToStreamParts(event, ctx);
      expect((parts[0] as any).isError).toBe(true);
    });

    it("stringifies object results", () => {
      ctx.toolStates.set("tc_obj_res", {
        toolCallId: "tc_obj_res",
        toolName: "read",
        args: {},
        startTime: Date.now(),
        inputAccumulator: "",
        hasEmittedStart: true,
      });

      const event: AgentSessionEvent = {
        type: "tool_execution_end",
        toolCallId: "tc_obj_res",
        toolName: "read",
        result: { content: "file data", lines: 10 },
        isError: false,
      };

      const parts = mapPiEventToStreamParts(event, ctx);
      expect((parts[0] as any).result).toBe(
        '{"content":"file data","lines":10}',
      );
    });

    it("handles null/undefined results", () => {
      ctx.toolStates.set("tc_null", {
        toolCallId: "tc_null",
        toolName: "bash",
        args: {},
        startTime: Date.now(),
        inputAccumulator: "",
        hasEmittedStart: true,
      });

      const event: AgentSessionEvent = {
        type: "tool_execution_end",
        toolCallId: "tc_null",
        toolName: "bash",
        result: undefined,
        isError: false,
      };

      const parts = mapPiEventToStreamParts(event, ctx);
      expect((parts[0] as any).result).toBe('""');
    });

    it("truncates long results", () => {
      const smallCtx = createCtx({ maxToolResultSize: 20 });
      smallCtx.toolStates.set("tc_long", {
        toolCallId: "tc_long",
        toolName: "bash",
        args: {},
        startTime: Date.now(),
        inputAccumulator: "",
        hasEmittedStart: true,
      });

      const event: AgentSessionEvent = {
        type: "tool_execution_end",
        toolCallId: "tc_long",
        toolName: "bash",
        result: "a".repeat(100),
        isError: false,
      };

      const parts = mapPiEventToStreamParts(event, smallCtx);
      const result = (parts[0] as any).result as string;
      expect(result).toContain("[truncated");
      expect(result.length).toBeLessThan(100);
    });

    it("does not truncate results within limit", () => {
      ctx.toolStates.set("tc_short", {
        toolCallId: "tc_short",
        toolName: "bash",
        args: {},
        startTime: Date.now(),
        inputAccumulator: "",
        hasEmittedStart: true,
      });

      const event: AgentSessionEvent = {
        type: "tool_execution_end",
        toolCallId: "tc_short",
        toolName: "bash",
        result: "short result",
        isError: false,
      };

      const parts = mapPiEventToStreamParts(event, ctx);
      expect((parts[0] as any).result).toBe("short result");
    });
  });

  // ═══════════════════════════════════════════
  //  message_end
  // ═══════════════════════════════════════════

  describe("message_end", () => {
    it("closes open text part", () => {
      // Start text
      mapPiEventToStreamParts(
        makeMessageUpdateEvent({
          type: "text_delta",
          contentIndex: 0,
          delta: "Hi",
          partial: {} as any,
        }),
        ctx,
      );
      expect(ctx.activeTextPartId).toBeDefined();

      const event: AgentSessionEvent = {
        type: "message_end",
        message: {
          role: "assistant",
          stopReason: "end_turn",
          usage: {},
        } as any,
      };

      const parts = mapPiEventToStreamParts(event, ctx);

      const textEnd = parts.find((p) => p.type === "text-end");
      expect(textEnd).toBeDefined();
      expect(ctx.activeTextPartId).toBeUndefined();
    });

    it("closes open reasoning part", () => {
      mapPiEventToStreamParts(
        makeMessageUpdateEvent({
          type: "thinking_delta",
          contentIndex: 0,
          delta: "thinking...",
          partial: {} as any,
        }),
        ctx,
      );
      expect(ctx.activeReasoningPartId).toBeDefined();

      const event: AgentSessionEvent = {
        type: "message_end",
        message: { role: "assistant", stopReason: "stop", usage: {} } as any,
      };

      const parts = mapPiEventToStreamParts(event, ctx);
      const reasoningEnd = parts.find((p) => p.type === "reasoning-end");
      expect(reasoningEnd).toBeDefined();
      expect(ctx.activeReasoningPartId).toBeUndefined();
    });

    it("extracts usage, finishReason, and piMeta from assistant message", () => {
      const msg = {
        role: "assistant",
        provider: "anthropic",
        model: "claude-sonnet-4",
        responseModel: "claude-sonnet-4-20250514",
        responseId: "resp_abc",
        stopReason: "end_turn",
        usage: { input: 100, output: 50, cacheRead: 10, cacheWrite: 5 },
      } as any;

      const event: AgentSessionEvent = {
        type: "message_end",
        message: msg,
      };

      mapPiEventToStreamParts(event, ctx);

      expect(ctx.usage.inputTokens.total).toBe(100);
      expect(ctx.usage.outputTokens.total).toBe(50);
      expect(ctx.usage.inputTokens.cacheRead).toBe(10);
      expect(ctx.usage.inputTokens.cacheWrite).toBe(5);
      expect(ctx.finishReason.unified).toBe("stop"); // end_turn → stop
      expect(ctx.piMeta.provider).toBe("anthropic");
      expect(ctx.piMeta.modelId).toBe("claude-sonnet-4");
      expect(ctx.piMeta.responseModel).toBe("claude-sonnet-4-20250514");
      expect(ctx.piMeta.responseId).toBe("resp_abc");
    });

    it("handles message_end with toolUse stopReason", () => {
      const event: AgentSessionEvent = {
        type: "message_end",
        message: {
          role: "assistant",
          stopReason: "toolUse",
          usage: { input: 10, output: 20 },
        } as any,
      };

      mapPiEventToStreamParts(event, ctx);

      expect(ctx.finishReason.unified).toBe("tool-calls");
    });

    it("does not update ctx for non-assistant message_end", () => {
      const event: AgentSessionEvent = {
        type: "message_end",
        message: { role: "user" } as any,
      };

      const prevUsage = ctx.usage;
      const prevReason = ctx.finishReason;

      const parts = mapPiEventToStreamParts(event, ctx);

      expect(ctx.usage).toStrictEqual(prevUsage);
      expect(ctx.finishReason).toStrictEqual(prevReason);
      expect(parts).toHaveLength(0);
    });

    it("closes both text and reasoning simultaneously when both are active", () => {
      mapPiEventToStreamParts(
        makeMessageUpdateEvent({
          type: "text_delta",
          contentIndex: 0,
          delta: "text",
          partial: {} as any,
        }),
        ctx,
      );
      mapPiEventToStreamParts(
        makeMessageUpdateEvent({
          type: "thinking_delta",
          contentIndex: 0,
          delta: "think",
          partial: {} as any,
        }),
        ctx,
      );

      const event: AgentSessionEvent = {
        type: "message_end",
        message: { role: "assistant", stopReason: "stop", usage: {} } as any,
      };

      const parts = mapPiEventToStreamParts(event, ctx);

      expect(parts.filter((p) => p.type === "text-end")).toHaveLength(1);
      expect(parts.filter((p) => p.type === "reasoning-end")).toHaveLength(1);
      expect(ctx.activeTextPartId).toBeUndefined();
      expect(ctx.activeReasoningPartId).toBeUndefined();
    });
  });

  // ═══════════════════════════════════════════
  //  agent_end
  // ═══════════════════════════════════════════

  describe("agent_end", () => {
    it("closes open text and reasoning parts and emits finish", () => {
      // Start both text and reasoning
      mapPiEventToStreamParts(
        makeMessageUpdateEvent({
          type: "text_delta",
          contentIndex: 0,
          delta: "final text",
          partial: {} as any,
        }),
        ctx,
      );
      mapPiEventToStreamParts(
        makeMessageUpdateEvent({
          type: "thinking_delta",
          contentIndex: 0,
          delta: "final thought",
          partial: {} as any,
        }),
        ctx,
      );

      // Set usage/finish directly in ctx (simulating prior message_end)
      ctx.usage = {
        inputTokens: {
          total: 200,
          noCache: undefined,
          cacheRead: undefined,
          cacheWrite: undefined,
        },
        outputTokens: { total: 100, text: undefined, reasoning: undefined },
      };
      ctx.finishReason = { unified: "stop", raw: undefined };

      const event: AgentSessionEvent = {
        type: "agent_end",
        messages: [],
        willRetry: false,
      };

      const parts = mapPiEventToStreamParts(event, ctx);

      // Should have text-end, reasoning-end, and finish
      expect(parts.filter((p) => p.type === "text-end")).toHaveLength(1);
      expect(parts.filter((p) => p.type === "reasoning-end")).toHaveLength(1);

      const finish = parts.find((p) => p.type === "finish") as any;
      expect(finish).toBeDefined();
      expect(finish.finishReason.unified).toBe("stop");
      expect(finish.usage.inputTokens.total).toBe(200);
      expect(finish.usage.outputTokens.total).toBe(100);
      expect(finish.providerMetadata).toBeDefined();

      // Verify durationMs was set
      const durationMeta = finish.providerMetadata?.durationMs as any;
      expect(durationMeta).toBeDefined();
      expect(Number(durationMeta.value)).toBeGreaterThanOrEqual(0);

      expect(ctx.activeTextPartId).toBeUndefined();
      expect(ctx.activeReasoningPartId).toBeUndefined();
    });

    it("emits finish with correct finishReason (tool-calls)", () => {
      ctx.finishReason = { unified: "tool-calls", raw: "toolUse" };

      const event: AgentSessionEvent = {
        type: "agent_end",
        messages: [],
        willRetry: false,
      };

      const parts = mapPiEventToStreamParts(event, ctx);
      const finish = parts.find((p) => p.type === "finish") as any;
      expect(finish.finishReason.unified).toBe("tool-calls");
    });

    it("emits finish even when no text or reasoning is active", () => {
      const event: AgentSessionEvent = {
        type: "agent_end",
        messages: [],
        willRetry: false,
      };

      const parts = mapPiEventToStreamParts(event, ctx);

      // Only finish
      expect(parts).toHaveLength(1);
      expect(parts[0].type).toBe("finish");
    });

    it("sets durationMs in providerMetadata", () => {
      const startCtx = createCtx({ startTime: Date.now() - 5000 }); // 5 seconds ago

      const event: AgentSessionEvent = {
        type: "agent_end",
        messages: [],
        willRetry: false,
      };

      const parts = mapPiEventToStreamParts(event, startCtx);
      const finish = parts.find((p) => p.type === "finish") as any;
      const durationMs = Number(finish.providerMetadata.durationMs.value);
      expect(durationMs).toBeGreaterThanOrEqual(5000);
    });
  });

  // ═══════════════════════════════════════════
  //  No-op events
  // ═══════════════════════════════════════════

  describe("no-op events", () => {
    const noOpEvents: Array<{ label: string; event: AgentSessionEvent }> = [
      { label: "agent_start", event: { type: "agent_start" } },
      { label: "turn_start", event: { type: "turn_start" } },
      {
        label: "turn_end",
        event: { type: "turn_end", message: {} as any, toolResults: [] },
      },
      {
        label: "message_start",
        event: { type: "message_start", message: {} as any },
      },
      {
        label: "queue_update",
        event: { type: "queue_update", steering: [], followUp: [] },
      },
      {
        label: "compaction_start",
        event: { type: "compaction_start", reason: "threshold" },
      },
      {
        label: "compaction_end",
        event: {
          type: "compaction_end",
          reason: "threshold",
          result: undefined,
          aborted: false,
          willRetry: false,
        },
      },
      {
        label: "session_info_changed",
        event: { type: "session_info_changed", name: undefined },
      },
      {
        label: "thinking_level_changed",
        event: { type: "thinking_level_changed", level: "high" },
      },
      {
        label: "auto_retry_start",
        event: {
          type: "auto_retry_start",
          attempt: 1,
          maxAttempts: 3,
          delayMs: 1000,
          errorMessage: "error",
        },
      },
      {
        label: "auto_retry_end",
        event: {
          type: "auto_retry_end",
          success: true,
          attempt: 1,
        },
      },
      {
        label: "tool_execution_update",
        event: {
          type: "tool_execution_update",
          toolCallId: "tc",
          toolName: "bash",
          args: {},
          partialResult: {},
        },
      },
    ];

    for (const { label, event } of noOpEvents) {
      it(`${label} returns empty array`, () => {
        const parts = mapPiEventToStreamParts(event, ctx);
        expect(parts).toEqual([]);
      });
    }
  });

  // ═══════════════════════════════════════════
  //  message_update done / error sub-events
  // ═══════════════════════════════════════════

  describe("message_update done/error sub-events", () => {
    it("done sub-event emits a finish part", () => {
      const event = makeMessageUpdateEvent({
        type: "done",
        reason: "stop",
        message: {} as any,
      });
      const parts = mapPiEventToStreamParts(event, ctx);
      expect(parts).toHaveLength(1);
      expect(parts[0].type).toBe("finish");
    });

    it("error sub-event emits a finish part", () => {
      const event = makeMessageUpdateEvent({
        type: "error",
        reason: "aborted",
        error: {} as any,
      });

      const parts = mapPiEventToStreamParts(event, ctx);
      expect(parts).toHaveLength(1);
      expect(parts[0].type).toBe("finish");
    });
  });

  // ═══════════════════════════════════════════
  //  top-level message_start (not sub-event)
  // ═══════════════════════════════════════════

  describe("top-level message_start", () => {
    it("does not emit response-metadata (only sub-event start does)", () => {
      const event: AgentSessionEvent = {
        type: "message_start",
        message: { role: "assistant" } as any,
      };

      const parts = mapPiEventToStreamParts(event, ctx);
      expect(parts).toEqual([]);
    });
  });

  // ═══════════════════════════════════════════
  //  Multiple sequential tool calls
  // ═══════════════════════════════════════════

  describe("multiple sequential tool calls", () => {
    it("assigns separate IDs and doesn't collide state", () => {
      const tc1 = "tc_alpha";
      const tc2 = "tc_beta";

      const events: AgentSessionEvent[] = [
        // Tool 1
        makeMessageUpdateEvent({
          type: "toolcall_start",
          contentIndex: 0,
          partial: makeToolCallPartial(tc1, "read", {}),
        }),
        makeMessageUpdateEvent({
          type: "toolcall_end",
          contentIndex: 0,
          toolCall: makeToolCall(tc1, "read", { path: "/a" }),
          partial: makeToolCallPartial(tc1, "read", {}),
        }),
        // Tool 2
        makeMessageUpdateEvent({
          type: "toolcall_start",
          contentIndex: 0,
          partial: makeToolCallPartial(tc2, "bash", {}),
        }),
        makeMessageUpdateEvent({
          type: "toolcall_end",
          contentIndex: 0,
          toolCall: makeToolCall(tc2, "bash", { command: "ls" }),
          partial: makeToolCallPartial(tc2, "bash", {}),
        }),
      ];

      const parts = collectParts(events, ctx);

      const toolCalls = parts.filter((p) => p.type === "tool-call");
      expect(toolCalls).toHaveLength(2);

      const call1 = toolCalls[0] as any;
      const call2 = toolCalls[1] as any;
      expect(call1.toolCallId).toBe(tc1);
      expect(call1.toolName).toBe("read");
      expect(call2.toolCallId).toBe(tc2);
      expect(call2.toolName).toBe("bash");
      expect(call1.toolCallId).not.toBe(call2.toolCallId);
    });
  });

  // ═══════════════════════════════════════════
  //  Session info propagation
  // ═══════════════════════════════════════════

  describe("session info in piMeta", () => {
    it("sets sessionId in piMeta on message_end", () => {
      const ctxWithSession = createCtx({ sessionId: "sess-xyz" });

      const event: AgentSessionEvent = {
        type: "message_end",
        message: {
          role: "assistant",
          provider: "test",
          model: "test-model",
          stopReason: "stop",
          usage: { input: 1, output: 1 },
        } as any,
      };

      mapPiEventToStreamParts(event, ctxWithSession);

      expect(ctxWithSession.piMeta.sessionId).toBe("sess-xyz");
    });
  });

  // ═══════════════════════════════════════════
  //  Multiple calls preserve state correctly
  // ═══════════════════════════════════════════

  describe("state preservation across calls", () => {
    it("preserves piMeta across multiple message_end events", () => {
      const event1: AgentSessionEvent = {
        type: "message_end",
        message: {
          role: "assistant",
          provider: "first",
          model: "model1",
          stopReason: "stop",
          usage: { input: 10, output: 5 },
        } as any,
      };

      const event2: AgentSessionEvent = {
        type: "message_end",
        message: {
          role: "assistant",
          provider: "second",
          model: "model2",
          stopReason: "end_turn",
          usage: { input: 20, output: 10 },
        } as any,
      };

      mapPiEventToStreamParts(event1, ctx);
      expect(ctx.piMeta.provider).toBe("first");
      expect(ctx.usage.inputTokens.total).toBe(10);

      mapPiEventToStreamParts(event2, ctx);
      // Second event overwrites (last one wins)
      expect(ctx.piMeta.provider).toBe("second");
      expect(ctx.usage.inputTokens.total).toBe(20);
    });

    it("clears activeTextPartId after text_end sub-event", () => {
      const events: AgentSessionEvent[] = [
        makeMessageUpdateEvent({
          type: "text_start",
          contentIndex: 0,
          partial: {} as any,
        }),
        makeMessageUpdateEvent({
          type: "text_end",
          contentIndex: 0,
          content: "done",
          partial: {} as any,
        }),
      ];

      collectParts(events, ctx);

      expect(ctx.activeTextPartId).toBeUndefined();
    });

    it("clears activeReasoningPartId after thinking_end sub-event", () => {
      const events: AgentSessionEvent[] = [
        makeMessageUpdateEvent({
          type: "thinking_start",
          contentIndex: 0,
          partial: {} as any,
        }),
        makeMessageUpdateEvent({
          type: "thinking_end",
          contentIndex: 0,
          content: "done thinking",
          partial: {} as any,
        }),
      ];

      collectParts(events, ctx);

      expect(ctx.activeReasoningPartId).toBeUndefined();
    });
  });
});

// ─── extractUsage ───

describe("extractUsage", () => {
  const baseUsage: PiUsage = {
    input: 100,
    output: 50,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 150,
    cost: {
      input: 0.01,
      output: 0.02,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0.03,
    },
  };

  it("computes noCache = input when cacheRead is 0", () => {
    const result = extractUsage(baseUsage);
    expect(result.inputTokens.noCache).toBe(100);
  });

  it("computes noCache = input - cacheRead when cacheRead > 0", () => {
    const result = extractUsage({
      ...baseUsage,
      input: 100,
      cacheRead: 30,
      cacheWrite: 5,
    });
    expect(result.inputTokens.noCache).toBe(70);
    expect(result.inputTokens.cacheRead).toBe(30);
    expect(result.inputTokens.cacheWrite).toBe(5);
  });

  it("guards against negative noCache", () => {
    const result = extractUsage({
      ...baseUsage,
      input: 10,
      cacheRead: 50,
    });
    expect(result.inputTokens.noCache).toBe(0);
  });

  it("populates outputTokens.text = output", () => {
    const result = extractUsage(baseUsage);
    expect(result.outputTokens.text).toBe(50);
    expect(result.outputTokens.total).toBe(50);
  });

  it("normalizes raw to a stable shape", () => {
    const result = extractUsage(baseUsage);
    const raw = result.raw as unknown as Record<string, unknown>;
    expect(raw.input).toBe(100);
    expect(raw.output).toBe(50);
    expect(raw.cacheRead).toBe(0);
    expect(raw.cacheWrite).toBe(0);
    expect(raw.totalTokens).toBe(150);
    expect(raw.cost).toEqual({
      input: 0.01,
      output: 0.02,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0.03,
    });
  });

  it("handles zero usage", () => {
    const result = extractUsage({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    });
    expect(result.inputTokens.total).toBe(0);
    expect(result.outputTokens.total).toBe(0);
    expect(result.inputTokens.noCache).toBe(0);
    expect(result.outputTokens.text).toBe(0);
  });
});

// ─── Helper function for tool call partials ───
function makeToolCallPartial(
  id: string,
  name: string,
  args: Record<string, unknown>,
): any {
  return {
    content: [{ type: "toolCall", id, name, arguments: args }],
  };
}
