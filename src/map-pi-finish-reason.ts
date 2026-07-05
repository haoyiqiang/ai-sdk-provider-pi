import type { LanguageModelV3FinishReason } from "@ai-sdk/provider";
import type { StopReason } from "@earendil-works/pi-ai";

/**
 * Maps Pi SDK stopReason values to AI SDK finish reasons.
 *
 * Pi's StopReason comes from the LLM provider API (Anthropic, OpenAI, etc.)
 * and follows provider-specific conventions. This function normalizes them
 * to AI SDK's unified finish reason format.
 *
 * @param stopReason - The stopReason from Pi's AssistantMessage
 * @returns The corresponding AI SDK finish reason with unified and raw values
 *
 * @example
 * ```typescript
 * mapPiFinishReason('end_turn');
 * // Returns: { unified: 'stop', raw: 'end_turn' }
 *
 * mapPiFinishReason('tool_use');
 * // Returns: { unified: 'tool-calls', raw: 'tool_use' }
 * ```
 */
export function mapPiFinishReason(
  stopReason?: StopReason | string
): LanguageModelV3FinishReason {
  if (stopReason == null) {
    return { unified: "stop", raw: undefined };
  }

  const raw = stopReason;

  // Anthropic-style stop reasons
  switch (stopReason) {
    case "end_turn":
      return { unified: "stop", raw };
    case "max_tokens":
      return { unified: "length", raw };
    case "stop_sequence":
      return { unified: "stop", raw };
    case "tool_use":
      return { unified: "tool-calls", raw };
    case "toolUse":
      return { unified: "tool-calls", raw };
    // OpenAI-style stop reasons
    case "stop":
      return { unified: "stop", raw };
    case "length":
      return { unified: "length", raw };
    case "tool_calls":
      return { unified: "tool-calls", raw };
    case "content_filter":
      return { unified: "content-filter", raw };
    // Google-style stop reasons
    case "STOP":
      return { unified: "stop", raw };
    case "MAX_TOKENS":
      return { unified: "length", raw };
    case "SAFETY":
      return { unified: "content-filter", raw };
    case "RECITATION":
      return { unified: "content-filter", raw };
    case "MALFORMED_FUNCTION_CALL":
      return { unified: "error", raw };
    // Mistral-style stop reasons
    case "tool_call":
      return { unified: "tool-calls", raw };
    // Generic error cases
    case "error":
      return { unified: "error", raw };
    case "aborted":
      return { unified: "error", raw };
    default:
      return { unified: "other", raw };
  }
}
