import type {
  AssistantMessage,
  Context,
  ImageContent,
  Message,
  TextContent,
  ToolResultMessage,
  UserMessage,
} from "@earendil-works/pi-ai";
import type { ModelMessage } from "ai";

const IMAGE_URL_WARNING =
  "Image URLs are not supported by this provider; supply base64/data URLs.";

/**
 * Converts AI SDK ModelMessage[] to Pi SDK Context format.
 */
export function convertToPiMessages(prompt: readonly ModelMessage[]): {
  context: Context;
  warnings: string[];
} {
  const messages: Message[] = [];
  const warnings: string[] = [];
  let systemPrompt: string | undefined;

  for (const message of prompt) {
    switch (message.role) {
      case "system": {
        if (typeof message.content === "string") {
          systemPrompt = message.content;
        }
        break;
      }

      case "user": {
        const piMessage = convertUserMessage(message, warnings);
        messages.push(piMessage);
        break;
      }

      case "assistant": {
        const piMessage = convertAssistantMessage(message);
        if (piMessage) {
          messages.push(piMessage);
        }
        break;
      }

      case "tool": {
        const piMessages = convertToolMessage(message);
        for (const piMsg of piMessages) {
          messages.push(piMsg);
        }
        break;
      }
    }
  }

  return {
    context: {
      systemPrompt,
      messages,
    },
    warnings,
  };
}

/**
 * Converts an AI SDK user message to a Pi UserMessage.
 */
function convertUserMessage(
  message: ModelMessage & { role: "user" },
  warnings: string[],
): UserMessage {
  if (typeof message.content === "string") {
    return {
      role: "user",
      content: message.content,
      timestamp: Date.now(),
    };
  }

  const contentParts: (TextContent | ImageContent)[] = [];
  let textContent = "";

  for (const part of message.content) {
    switch (part.type) {
      case "text": {
        textContent += part.text;
        contentParts.push({ type: "text", text: part.text });
        break;
      }

      case "image": {
        const image = convertImagePart(part);
        if (image) {
          contentParts.push(image);
        } else {
          warnings.push(IMAGE_URL_WARNING);
        }
        break;
      }

      case "file": {
        // FilePart in AI SDK v6: { type: 'file', data: DataContent | URL, filename?, mediaType: string }
        const data = part.data;
        const mediaType = part.mediaType;

        if (data instanceof URL) {
          warnings.push(IMAGE_URL_WARNING);
          break;
        }

        if (data instanceof Uint8Array || data instanceof ArrayBuffer) {
          const base64 = convertBinaryToBase64(data);
          if (base64 && mediaType?.startsWith("image/")) {
            contentParts.push({
              type: "image",
              data: base64,
              mimeType: mediaType,
            });
          }
        } else if (
          typeof data === "string" &&
          mediaType &&
          mediaType.startsWith("image/")
        ) {
          contentParts.push({ type: "image", data, mimeType: mediaType });
        }
        break;
      }
    }
  }

  if (contentParts.every((p) => p.type === "text") && contentParts.length > 0) {
    return {
      role: "user",
      content: contentParts.map((p) => (p as TextContent).text).join("\n"),
      timestamp: Date.now(),
    };
  }

  return {
    role: "user",
    content: contentParts.length > 0 ? contentParts : textContent,
    timestamp: Date.now(),
  };
}

/**
 * Converts an AI SDK assistant message to a Pi AssistantMessage.
 * Returns null if the message has no usable content.
 */
function convertAssistantMessage(
  message: ModelMessage & { role: "assistant" },
): AssistantMessage | null {
  const content: AssistantMessage["content"] = [];

  if (typeof message.content === "string") {
    if (message.content) {
      content.push({ type: "text", text: message.content });
    }
  } else if (Array.isArray(message.content)) {
    for (const part of message.content) {
      switch (part.type) {
        case "text": {
          if (part.text) {
            content.push({ type: "text", text: part.text });
          }
          break;
        }

        case "reasoning": {
          if (part.text) {
            content.push({ type: "thinking", thinking: part.text });
          }
          break;
        }

        case "tool-call": {
          // AI SDK v6: { type: 'tool-call', toolCallId, toolName, input, providerExecuted? }
          content.push({
            type: "toolCall",
            id: part.toolCallId,
            name: part.toolName,
            arguments:
              typeof part.input === "string"
                ? JSON.parse(part.input)
                : ((part.input as Record<string, unknown>) ?? {}),
          });
          break;
        }
      }
    }
  }

  if (content.length === 0) {
    return null;
  }

  return {
    role: "assistant",
    content,
    api: "unknown" as AssistantMessage["api"],
    provider: "unknown",
    model: "unknown",
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
  };
}

/**
 * Converts an AI SDK tool message to Pi ToolResultMessage(s).
 * AI SDK v6: ToolResultPart has `output: ToolResultOutput` (not `result`)
 */
function convertToolMessage(
  message: ModelMessage & { role: "tool" },
): ToolResultMessage[] {
  const results: ToolResultMessage[] = [];

  for (const part of message.content) {
    if (part.type === "tool-result") {
      let resultContent: (TextContent | ImageContent)[];
      let isError = false;

      // AI SDK v6 uses `output` field with structured type
      const output = part.output;

      if (output.type === "text") {
        resultContent = [{ type: "text", text: output.value }];
      } else if (output.type === "json") {
        resultContent = [{ type: "text", text: JSON.stringify(output.value) }];
      } else if (output.type === "error-text") {
        resultContent = [{ type: "text", text: output.value }];
        isError = true;
      } else if (output.type === "error-json") {
        resultContent = [{ type: "text", text: JSON.stringify(output.value) }];
        isError = true;
      } else if (output.type === "execution-denied") {
        resultContent = [{ type: "text", text: "[Execution denied]" }];
      } else if (output.type === "content") {
        resultContent = output.value
          .filter((p): p is { type: "text"; text: string } => p.type === "text")
          .map((p) => ({ type: "text" as const, text: p.text }));
      } else {
        resultContent = [{ type: "text", text: String(output) }];
      }

      results.push({
        role: "toolResult",
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        content: resultContent,
        isError,
        timestamp: Date.now(),
      });
    }
  }

  return results;
}

/**
 * Converts an AI SDK image part to a Pi ImageContent.
 */
function convertImagePart(part: {
  image?: unknown;
  mimeType?: string;
}): ImageContent | null {
  const imageValue = part.image;
  const mimeType = part.mimeType;

  if (typeof imageValue === "string") {
    const trimmed = imageValue.trim();
    const dataUrlMatch = trimmed.match(/^data:([^;]+);base64,(.+)$/i);
    if (dataUrlMatch) {
      return {
        type: "image",
        data: dataUrlMatch[2],
        mimeType: dataUrlMatch[1],
      };
    }
    if (mimeType) {
      return { type: "image", data: trimmed, mimeType };
    }
    if (/^https?:\/\//i.test(trimmed)) {
      return null;
    }
    return null;
  }

  if (imageValue && typeof imageValue === "object") {
    const obj = imageValue as Record<string, unknown>;
    const data = typeof obj.data === "string" ? obj.data : undefined;
    const mt = (obj.mimeType ?? obj.mediaType ?? mimeType) as
      | string
      | undefined;
    if (data && mt) {
      return { type: "image", data, mimeType: mt };
    }
  }

  return null;
}

/**
 * Converts binary data to base64 string.
 */
function convertBinaryToBase64(
  data: Uint8Array | ArrayBuffer,
): string | undefined {
  if (typeof Buffer !== "undefined") {
    const buffer =
      data instanceof Uint8Array
        ? Buffer.from(data)
        : Buffer.from(new Uint8Array(data));
    return buffer.toString("base64");
  }
  if (typeof btoa === "function") {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    let binary = "";
    const chunkSize = 0x80_00;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      const chunk = bytes.subarray(i, i + chunkSize);
      binary += String.fromCharCode(...chunk);
    }
    return btoa(binary);
  }
  return undefined;
}

/**
 * Builds the user prompt text from a Pi Context.
 * For a fresh conversation, this is just the last user message.
 */
export function buildPromptFromContext(context: Context): string {
  const lastUserMessage = context.messages
    .filter((m) => m.role === "user")
    .pop();

  if (lastUserMessage && lastUserMessage.role === "user") {
    if (typeof lastUserMessage.content === "string") {
      return lastUserMessage.content;
    }
    return lastUserMessage.content
      .filter((p): p is TextContent => p.type === "text")
      .map((p) => p.text)
      .join("\n");
  }

  return "";
}
