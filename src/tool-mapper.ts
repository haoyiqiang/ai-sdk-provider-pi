/**
 * Tool mapping utilities for the Pi AI SDK provider.
 *
 * Provides safe serialization and structured truncation for tool calls
 * and tool results flowing between Pi Coding Agent and the AI SDK.
 */

/** Default maximum size for tool results. */
export const DEFAULT_MAX_TOOL_RESULT_SIZE = 10_000;

/** Fallback tool name when none is provided. */
const UNKNOWN_TOOL_NAME = "unknown_tool";

/**
 * Structured result from truncating a JSON value.
 */
export interface TruncateResult {
  /** Whether the value was truncated. */
  truncated: boolean;
  /** The maximum size in characters. */
  maxSize: number;
  /** The preview string (truncated if necessary). */
  preview: string;
}

/**
 * Safe JSON stringify that handles circular references and BigInt values.
 *
 * Falls back through multiple strategies:
 * 1. Plain `JSON.stringify` (fast path for normal values)
 * 2. Replacer-based with WeakSet cycle detection and BigInt → string conversion
 * 3. `String(value)` as ultimate fallback
 */
export function safeStringify(value: unknown, space?: number): string {
  // Fast path: normal JSON-serializable values
  try {
    const fastResult = JSON.stringify(value, null, space);
    if (fastResult !== undefined) {
      return fastResult;
    }
  } catch {
    // Fall through to replacer-based approach
  }

  // Replacer-based: handle cycles and BigInt
  try {
    const seen = new WeakSet<object>();
    const replacerResult = JSON.stringify(
      value,
      (_key: string, val: unknown) => {
        if (typeof val === "bigint") {
          return val.toString();
        }
        if (val !== null && typeof val === "object") {
          if (seen.has(val)) {
            return "[Circular]";
          }
          seen.add(val);
        }
        return val;
      },
      space,
    );
    if (replacerResult !== undefined) {
      return replacerResult;
    }
  } catch {
    // Replacer failed, fall through
  }

  // Ultimate fallback
  return String(value);
}

/**
 * Structured JSON truncation.
 *
 * Stringifies the value with `safeStringify`, then if the result exceeds
 * `maxSize`, truncates and appends a truncation marker.
 *
 * @returns A `TruncateResult` with truncation status and preview.
 */
export function truncateJsonValue(
  value: unknown,
  maxSize: number,
): TruncateResult {
  const serialized =
    typeof value === "string" ? value : safeStringify(value);

  if (serialized.length <= maxSize) {
    return {
      truncated: false,
      maxSize,
      preview: serialized,
    };
  }

  const excess = serialized.length - maxSize;
  const preview = `${serialized.slice(0, maxSize)}...[truncated ${excess} chars]`;

  return {
    truncated: true,
    maxSize,
    preview,
  };
}

/**
 * Maps a Pi tool call to the AI SDK tool-call content format.
 *
 * Handles both string and object arguments, using `safeStringify`
 * for object arguments to avoid JSON serialization errors.
 */
export function mapPiToolCall(toolCall: {
  id: string;
  name: string;
  arguments: unknown;
}): {
  type: "tool-call";
  toolCallId: string;
  toolName: string;
  input: string;
} {
  return {
    type: "tool-call" as const,
    toolCallId: toolCall.id,
    toolName: toolCall.name || UNKNOWN_TOOL_NAME,
    input:
      typeof toolCall.arguments === "string"
        ? toolCall.arguments
        : safeStringify(toolCall.arguments),
  };
}

/**
 * Maps a Pi tool execution result to the AI SDK tool-result stream part.
 *
 * Stringifies non-string results with `safeStringify`, then applies
 * structured truncation via `truncateJsonValue`.
 *
 * @param event - The tool execution result from Pi
 * @param maxResultSize - Maximum character size for the result
 */
export function mapPiToolResult(
  event: {
    toolCallId: string;
    toolName: string;
    result: unknown;
    isError?: boolean;
  },
  maxResultSize: number = DEFAULT_MAX_TOOL_RESULT_SIZE,
): {
  type: "tool-result";
  toolCallId: string;
  toolName: string;
  result: string;
  isError: boolean | undefined;
  dynamic: true;
} {
  const resultText =
    typeof event.result === "string"
      ? event.result
      : safeStringify(event.result ?? "");

  const { preview } = truncateJsonValue(resultText, maxResultSize);

  return {
    type: "tool-result" as const,
    toolCallId: event.toolCallId,
    toolName: event.toolName,
    result: preview,
    isError: event.isError || undefined,
    dynamic: true as const,
  };
}
