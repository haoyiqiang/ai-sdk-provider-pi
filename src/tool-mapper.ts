/**
 * Tool mapping utilities for the Pi AI SDK provider.
 *
 * Provides safe serialization and structured truncation for tool calls
 * and tool results flowing between Pi Coding Agent and the AI SDK.
 */

/** Default maximum size for tool results. */
export const DEFAULT_MAX_TOOL_RESULT_SIZE = 10_000;

/** Fallback tool name when none is provided. */
export const UNKNOWN_TOOL_NAME = "unknown_tool";

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
 * Recursively normalizes an arbitrary value into a JSON-safe representation.
 *
 * - Functions / symbols / undefined are dropped (key-removed in objects,
 *   replaced with null in arrays).
 * - BigInt is converted to string.
 * - Circular references are replaced with the string "[Circular]".
 * - Everything else passes through.
 *
 * Running this before `safeStringify` guarantees that truncation never
 * throws on pathological tool output (cycles, BigInt, non-serializable
 * values).
 */
export function toJsonValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  const t = typeof value;
  if (t === "string" || t === "number" || t === "boolean") {
    return value;
  }
  if (t === "bigint") {
    return value.toString();
  }
  if (t === "function" || t === "symbol") {
    return undefined;
  }
  if (t !== "object") {
    return String(value);
  }
  if (seen.has(value as object)) {
    return "[Circular]";
  }
  seen.add(value as object);
  try {
    if (Array.isArray(value)) {
      return value.map((v) => toJsonValue(v, seen));
    }
    if (value instanceof Date) {
      return value.toISOString();
    }
    if (value instanceof Error) {
      return { name: value.name, message: value.message, stack: value.stack };
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const normalized = toJsonValue(v, seen);
      if (normalized !== undefined) {
        out[k] = normalized;
      }
    }
    return out;
  } finally {
    seen.delete(value as object);
  }
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
      : safeStringify(toJsonValue(event.result ?? ""));

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
