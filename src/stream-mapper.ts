import type {
  JSONObject,
  LanguageModelV3FinishReason,
  LanguageModelV3StreamPart,
  LanguageModelV3Usage,
  SharedV3ProviderMetadata,
} from "@ai-sdk/provider";
import type {
  AssistantMessage,
  Usage as PiUsage,
} from "@earendil-works/pi-ai";
import type {
  AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import { mapPiFinishReason } from "./map-pi-finish-reason.js";
import type {
  PiProviderMetadata,
  ToolStreamState,
} from "./types.js";

// ─── Constants ───

export const UNKNOWN_TOOL_NAME = "unknown_tool";
export const MAX_TOOL_RESULT_SIZE = 10_000;

// ─── Context type ───

/**
 * Mutable context carried across stream-mapper invocations.
 * The mapper reads and writes this context as it processes events.
 */
export interface StreamMapperContext {
  /** Currently active text part ID (auto-assigned on first delta). */
  activeTextPartId: string | undefined;
  /** Currently active reasoning part ID (auto-assigned on first delta). */
  activeReasoningPartId: string | undefined;
  /** Per-tool-call state for streaming input. */
  toolStates: Map<string, ToolStreamState>;
  /** Accumulated Pi provider metadata (populated on message_end). */
  piMeta: PiProviderMetadata;
  /** Accumulated usage (populated on message_end). */
  usage: LanguageModelV3Usage;
  /** Accumulated finish reason (populated on message_end). */
  finishReason: LanguageModelV3FinishReason;

  // ── Injected dependencies (readonly) ──

  /** ID generator (e.g. generateId from @ai-sdk/provider-utils). */
  generateId: () => string;
  /** Current Pi session ID, if available. */
  sessionId?: string;
  /** Timestamp when the stream started (used for durationMs). */
  startTime: number;
  /** Maximum tool result size before truncation. */
  maxToolResultSize: number;
  /** Converts PiProviderMetadata to AI SDK's SharedV3ProviderMetadata. */
  toProviderMetadata: (meta: PiProviderMetadata) => SharedV3ProviderMetadata;
}

// ── Helper functions ──

/**
 * Converts PiProviderMetadata to AI SDK's SharedV3ProviderMetadata.
 * SharedV3ProviderMetadata = Record<string, JSONObject>, so we need to wrap
 * primitive values in objects.
 */
export function toProviderMetadata(
  meta: PiProviderMetadata,
): SharedV3ProviderMetadata {
  const result: Record<string, JSONObject> = {};
  for (const [key, value] of Object.entries(meta)) {
    if (value != null && typeof value === "object") {
      result[key] = value as JSONObject;
    } else if (value != null) {
      result[key] = { value: String(value) } as unknown as JSONObject;
    }
  }
  return result;
}

/**
 * Creates an empty usage object with all fields set to undefined.
 */
export function createEmptyUsage(): LanguageModelV3Usage {
  return {
    inputTokens: {
      total: undefined,
      noCache: undefined,
      cacheRead: undefined,
      cacheWrite: undefined,
    },
    outputTokens: { total: undefined, text: undefined, reasoning: undefined },
  };
}

/**
 * Extracts usage from a Pi usage object.
 */
export function extractUsage(piUsage: PiUsage): LanguageModelV3Usage {
  return {
    inputTokens: {
      total: piUsage.input ?? undefined,
      noCache: undefined,
      cacheRead: piUsage.cacheRead ?? undefined,
      cacheWrite: piUsage.cacheWrite ?? undefined,
    },
    outputTokens: {
      total: piUsage.output ?? undefined,
      text: undefined,
      reasoning: undefined,
    },
    raw: piUsage as unknown as JSONObject,
  };
}

/**
 * Extracts a tool call from a partial assistant message at a given content index.
 * Returns null if the partial doesn't contain a tool call at that index.
 */
export function extractToolCallFromPartial(
  partial: AssistantMessage,
  contentIndex: number,
  generateId: () => string,
): { id: string; name: string; arguments: Record<string, unknown> } | null {
  if (!partial?.content || !Array.isArray(partial.content)) {
    return null;
  }
  const item = partial.content[contentIndex];
  if (item?.type !== "toolCall") {
    return null;
  }
  const tc = item as {
    type: "toolCall";
    id: string;
    name: string;
    arguments: Record<string, unknown>;
  };
  return {
    id: tc.id || generateId(),
    name: tc.name || UNKNOWN_TOOL_NAME,
    arguments: tc.arguments || {},
  };
}

/**
 * Truncates a tool result string if it exceeds the given max size.
 */
export function truncateToolResult(
  result: string,
  maxSize: number,
): string {
  if (result.length <= maxSize) {
    return result;
  }
  return `${result.slice(0, maxSize)}...[truncated ${result.length - maxSize} chars]`;
}

// ── Internal helpers ──

/**
 * Ensures a text part is started, emitting a text-start if needed.
 * Returns true if a new part was created.
 */
function ensureTextStarted(ctx: StreamMapperContext): boolean {
  if (ctx.activeTextPartId) {
    return false;
  }
  ctx.activeTextPartId = ctx.generateId();
  return true;
}

/**
 * Ensures a reasoning part is started, emitting a reasoning-start if needed.
 * Returns true if a new part was created.
 */
function ensureReasoningStarted(ctx: StreamMapperContext): boolean {
  if (ctx.activeReasoningPartId) {
    return false;
  }
  ctx.activeReasoningPartId = ctx.generateId();
  return true;
}

/**
 * Closes the active text part (if any) and returns the text-end part.
 */
function closeTextPart(
  ctx: StreamMapperContext,
  meta?: SharedV3ProviderMetadata,
): LanguageModelV3StreamPart | null {
  if (!ctx.activeTextPartId) {
    return null;
  }
  const part: LanguageModelV3StreamPart = {
    type: "text-end",
    id: ctx.activeTextPartId,
    ...(meta ? { providerMetadata: meta } : {}),
  };
  ctx.activeTextPartId = undefined;
  return part;
}

/**
 * Closes the active reasoning part (if any) and returns the reasoning-end part.
 */
function closeReasoningPart(
  ctx: StreamMapperContext,
  meta?: SharedV3ProviderMetadata,
): LanguageModelV3StreamPart | null {
  if (!ctx.activeReasoningPartId) {
    return null;
  }
  const part: LanguageModelV3StreamPart = {
    type: "reasoning-end",
    id: ctx.activeReasoningPartId,
    ...(meta ? { providerMetadata: meta } : {}),
  };
  ctx.activeReasoningPartId = undefined;
  return part;
}

/**
 * Extracts usage, finishReason, and providerMetadata from a message_end event.
 */
function extractMessageEndData(
  event: Extract<AgentSessionEvent, { type: "message_end" }>,
  sessionId: string | undefined,
): { usage: LanguageModelV3Usage; finishReason: LanguageModelV3FinishReason; piMeta: PiProviderMetadata } {
  let usage: LanguageModelV3Usage = createEmptyUsage();
  let finishReason: LanguageModelV3FinishReason = {
    unified: "stop",
    raw: undefined,
  };
  let piMeta: PiProviderMetadata = {};

  if (event.message?.role === "assistant") {
    const msg = event.message as AssistantMessage;
    usage = extractUsage(msg.usage);
    finishReason = mapPiFinishReason(msg.stopReason);
    piMeta = {
      sessionId,
      provider: msg.provider,
      modelId: msg.model,
      responseModel: msg.responseModel,
      responseId: msg.responseId,
    };
  }

  return { usage, finishReason, piMeta };
}

// ── Main mapper function ──

/**
 * Maps a single Pi AgentSessionEvent to zero or more LanguageModelV3StreamPart values.
 *
 * This is a pure-ish function: the parts array depends solely on the event and
 * the mutable `ctx`.  The function mutates `ctx` in place (tracking open parts,
 * accumulating tool state, etc.) but does not perform any I/O.
 *
 * @param event - A Pi Coding Agent session event.
 * @param ctx   - Mutable context carried across invocations.
 * @returns Zero or more AI SDK v3 stream parts to enqueue.
 */
export function mapPiEventToStreamParts(
  event: AgentSessionEvent,
  ctx: StreamMapperContext,
): LanguageModelV3StreamPart[] {
  const parts: LanguageModelV3StreamPart[] = [];

  switch (event.type) {
    case "message_update": {
      const msgEvent = event.assistantMessageEvent;
      const meta = ctx.toProviderMetadata(ctx.piMeta);

      switch (msgEvent.type) {
        case "start": {
          // response-metadata part at assistant message start
          parts.push({
            type: "response-metadata",
            id: ctx.sessionId ?? ctx.generateId(),
            timestamp: new Date(),
            modelId: undefined,
          });
          break;
        }

        case "text_start": {
          if (ensureTextStarted(ctx)) {
            parts.push({
              type: "text-start",
              id: ctx.activeTextPartId!,
              providerMetadata: meta,
            });
          }
          break;
        }

        case "text_delta": {
          if (ensureTextStarted(ctx)) {
            parts.push({
              type: "text-start",
              id: ctx.activeTextPartId!,
              providerMetadata: meta,
            });
          }
          parts.push({
            type: "text-delta",
            id: ctx.activeTextPartId!,
            delta: msgEvent.delta,
            providerMetadata: meta,
          });
          break;
        }

        case "text_end": {
          const closePart = closeTextPart(ctx, meta);
          if (closePart) {
            parts.push(closePart);
          }
          break;
        }

        case "thinking_start": {
          if (ensureReasoningStarted(ctx)) {
            parts.push({
              type: "reasoning-start",
              id: ctx.activeReasoningPartId!,
              providerMetadata: meta,
            });
          }
          break;
        }

        case "thinking_delta": {
          if (ensureReasoningStarted(ctx)) {
            parts.push({
              type: "reasoning-start",
              id: ctx.activeReasoningPartId!,
              providerMetadata: meta,
            });
          }
          parts.push({
            type: "reasoning-delta",
            id: ctx.activeReasoningPartId!,
            delta: msgEvent.delta,
            providerMetadata: meta,
          });
          break;
        }

        case "thinking_end": {
          const closePart = closeReasoningPart(ctx, meta);
          if (closePart) {
            parts.push(closePart);
          }
          break;
        }

        case "toolcall_start": {
          // Close open text part before tool call
          const textEnd = closeTextPart(ctx);
          if (textEnd) {
            parts.push(textEnd);
          }

          const tc = extractToolCallFromPartial(
            msgEvent.partial,
            msgEvent.contentIndex,
            ctx.generateId,
          );
          if (tc) {
            ctx.toolStates.set(tc.id, {
              toolCallId: tc.id,
              toolName: tc.name,
              args: tc.arguments,
              startTime: Date.now(),
              inputAccumulator: "",
              hasEmittedStart: true,
            });
            parts.push({
              type: "tool-input-start",
              id: tc.id,
              toolName: tc.name,
              providerExecuted: true,
              dynamic: true,
            });
          }
          break;
        }

        case "toolcall_delta": {
          const tc = extractToolCallFromPartial(
            msgEvent.partial,
            msgEvent.contentIndex,
            ctx.generateId,
          );
          if (tc && ctx.toolStates.has(tc.id)) {
            parts.push({
              type: "tool-input-delta",
              id: tc.id,
              delta: msgEvent.delta,
            });
            ctx.toolStates.get(tc.id)!.inputAccumulator += msgEvent.delta;
          }
          break;
        }

        case "toolcall_end": {
          const toolCallId = msgEvent.toolCall.id;
          if (ctx.toolStates.has(toolCallId)) {
            parts.push({
              type: "tool-input-end",
              id: toolCallId,
            });
            parts.push({
              type: "tool-call",
              toolCallId,
              toolName: msgEvent.toolCall.name,
              input:
                typeof msgEvent.toolCall.arguments === "string"
                  ? msgEvent.toolCall.arguments
                  : JSON.stringify(msgEvent.toolCall.arguments),
            });
          }
          break;
        }

        case "done":
        case "error": {
          // No stream parts for done/error sub-events.
          break;
        }
      }
      break;
    }

    case "tool_execution_start": {
      if (!ctx.toolStates.has(event.toolCallId)) {
        ctx.toolStates.set(event.toolCallId, {
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args: event.args,
          startTime: Date.now(),
          inputAccumulator: "",
          hasEmittedStart: true,
        });
        parts.push({
          type: "tool-input-start",
          id: event.toolCallId,
          toolName: event.toolName,
          providerExecuted: true,
          dynamic: true,
        });
      }
      break;
    }

    case "tool_execution_end": {
      const resultText = truncateToolResult(
        typeof event.result === "string"
          ? event.result
          : JSON.stringify(event.result ?? ""),
        ctx.maxToolResultSize,
      );
      parts.push({
        type: "tool-result",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        result: resultText as any,
        isError: event.isError || undefined,
        dynamic: true,
      });
      ctx.toolStates.delete(event.toolCallId);
      break;
    }

    case "message_end": {
      // Close any open text/reasoning parts
      const textEnd = closeTextPart(ctx);
      if (textEnd) {
        parts.push(textEnd);
      }
      const reasoningEnd = closeReasoningPart(ctx);
      if (reasoningEnd) {
        parts.push(reasoningEnd);
      }
      // Extract and accumulate metadata
      const endData = extractMessageEndData(event, ctx.sessionId);
      ctx.usage = endData.usage;
      ctx.finishReason = endData.finishReason;
      ctx.piMeta = endData.piMeta;
      break;
    }

    case "agent_end": {
      // Close any open text/reasoning parts
      const textEnd = closeTextPart(ctx);
      if (textEnd) {
        parts.push(textEnd);
      }
      const reasoningEnd = closeReasoningPart(ctx);
      if (reasoningEnd) {
        parts.push(reasoningEnd);
      }
      // Emit finish
      ctx.piMeta.durationMs = Date.now() - ctx.startTime;
      parts.push({
        type: "finish",
        finishReason: ctx.finishReason,
        usage: ctx.usage,
        providerMetadata: ctx.toProviderMetadata(ctx.piMeta),
      });
      break;
    }

    // No-op events (no stream parts emitted)
    case "agent_start":
    case "turn_start":
    case "turn_end":
    case "message_start":
    case "queue_update":
    case "compaction_start":
    case "compaction_end":
    case "session_info_changed":
    case "thinking_level_changed":
    case "auto_retry_start":
    case "auto_retry_end":
    case "tool_execution_update": {
      break;
    }
  }

  return parts;
}
