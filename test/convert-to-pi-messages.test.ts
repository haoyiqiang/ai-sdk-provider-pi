import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import {
  buildPromptFromContext,
  convertToPiMessages,
} from "../src/convert-to-pi-messages.js";

describe("convertToPiMessages", () => {
  // ── System messages ──

  it("extracts system prompt from system message", () => {
    const messages: ModelMessage[] = [
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: "Hello!" },
    ];
    const { context, warnings } = convertToPiMessages(messages);
    expect(context.systemPrompt).toBe("You are a helpful assistant.");
    expect(warnings).toEqual([]);
  });

  // ── User messages ──

  it("converts simple string user message", () => {
    const messages: ModelMessage[] = [{ role: "user", content: "Hello!" }];
    const { context, warnings } = convertToPiMessages(messages);
    expect(context.messages).toHaveLength(1);
    expect(context.messages[0].role).toBe("user");
    expect(warnings).toEqual([]);
  });

  it("converts user message with text parts", () => {
    const messages: ModelMessage[] = [
      {
        role: "user",
        content: [{ type: "text", text: "Hello from parts!" }],
      },
    ];
    const { context, warnings } = convertToPiMessages(messages);
    expect(context.messages).toHaveLength(1);
    expect(warnings).toEqual([]);
  });

  it("converts user message with image data URL", () => {
    const messages: ModelMessage[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "What is in this image?" },
          {
            type: "image",
            image: "data:image/png;base64,iVBORw0KGgo=",
            mimeType: "image/png",
          },
        ],
      },
    ];
    const { context, warnings } = convertToPiMessages(messages);
    expect(context.messages).toHaveLength(1);
    expect(warnings).toEqual([]);
  });

  it("warns about image URLs (not supported)", () => {
    const messages: ModelMessage[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "Check this image" },
          { type: "image", image: new URL("https://example.com/image.png") },
        ],
      },
    ];
    const { context: _context, warnings } = convertToPiMessages(messages);
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]).toContain("Image URLs are not supported");
  });

  // ── Assistant messages ──

  it("converts simple string assistant message", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "Hi" },
      { role: "assistant", content: "Hello! How can I help?" },
    ];
    const { context, warnings } = convertToPiMessages(messages);
    expect(context.messages).toHaveLength(2);
    const assistantMsg = context.messages[1];
    expect(assistantMsg.role).toBe("assistant");
    expect(warnings).toEqual([]);
  });

  it("converts assistant message with tool calls", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "Read file" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Let me read that file." },
          {
            type: "tool-call",
            toolCallId: "call_123",
            toolName: "read",
            input: '{"path": "/tmp/test.txt"}',
          },
        ],
      },
    ];
    const { context, warnings } = convertToPiMessages(messages);
    expect(context.messages).toHaveLength(2);
    expect(warnings).toEqual([]);
  });

  it("skips empty assistant messages", () => {
    const messages: ModelMessage[] = [{ role: "assistant", content: "" }];
    const { context, warnings: _warnings } = convertToPiMessages(messages);
    expect(context.messages).toHaveLength(0);
  });

  // ── Tool messages ──

  it("converts tool result messages", () => {
    const messages: ModelMessage[] = [
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call_123",
            toolName: "read",
            output: { type: "text", value: "File content here" },
          },
        ],
      },
    ];
    const { context, warnings } = convertToPiMessages(messages);
    expect(context.messages).toHaveLength(1);
    expect(context.messages[0].role).toBe("toolResult");
    expect(warnings).toEqual([]);
  });

  it("converts tool result with error output", () => {
    const messages: ModelMessage[] = [
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call_456",
            toolName: "bash",
            output: { type: "error-text", value: "Command failed" },
          },
        ],
      },
    ];
    const { context, warnings } = convertToPiMessages(messages);
    expect(context.messages).toHaveLength(1);
    const toolMsg = context.messages[0] as any;
    expect(toolMsg.isError).toBe(true);
    expect(warnings).toEqual([]);
  });

  it("converts tool result with json output", () => {
    const messages: ModelMessage[] = [
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call_789",
            toolName: "search",
            output: { type: "json", value: { results: ["a", "b"] } },
          },
        ],
      },
    ];
    const { context, warnings } = convertToPiMessages(messages);
    expect(context.messages).toHaveLength(1);
    expect(warnings).toEqual([]);
  });

  it("converts tool result with execution-denied output", () => {
    const messages: ModelMessage[] = [
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call_denied",
            toolName: "bash",
            output: { type: "execution-denied" },
          },
        ],
      },
    ];
    const { context, warnings } = convertToPiMessages(messages);
    expect(context.messages).toHaveLength(1);
    const toolMsg = context.messages[0] as any;
    expect(toolMsg.isError).toBe(false);
    expect(warnings).toEqual([]);
  });

  // ── Multi-turn conversation ──

  it("converts a full multi-turn conversation", () => {
    const messages: ModelMessage[] = [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there!" },
      { role: "user", content: "How are you?" },
    ];
    const { context, warnings } = convertToPiMessages(messages);
    expect(context.systemPrompt).toBe("You are helpful.");
    expect(context.messages).toHaveLength(3);
    expect(warnings).toEqual([]);
  });

  // ── Reasoning ──

  it("converts assistant message with reasoning", () => {
    const messages: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "Let me think about this..." },
          { type: "text", text: "Here is my answer." },
        ],
      },
    ];
    const { context, warnings } = convertToPiMessages(messages);
    expect(context.messages).toHaveLength(1);
    const assistantMsg = context.messages[1] ?? context.messages[0];
    expect(assistantMsg.role).toBe("assistant");
    expect(warnings).toEqual([]);
  });

  // ── File type support ──

  it("converts file with Uint8Array data and image mediaType", () => {
    const messages: ModelMessage[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "Analyze this file" },
          {
            type: "file",
            data: new Uint8Array([1, 2, 3]),
            mediaType: "image/png",
          } as any,
        ],
      },
    ];
    const { context, warnings } = convertToPiMessages(messages);
    expect(context.messages).toHaveLength(1);
    expect(warnings).toEqual([]);
  });

  it("warns about file with URL data", () => {
    const messages: ModelMessage[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "Check file" },
          {
            type: "file",
            data: new URL("https://example.com/file.png"),
            mediaType: "image/png",
          } as any,
        ],
      },
    ];
    const { context: _context, warnings } = convertToPiMessages(messages);
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]).toContain("Image URLs are not supported");
  });

  it("converts file with base64 string data", () => {
    const messages: ModelMessage[] = [
      {
        role: "user",
        content: [
          {
            type: "file",
            data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk",
            mediaType: "image/png",
          } as any,
        ],
      },
    ];
    const { context, warnings } = convertToPiMessages(messages);
    expect(context.messages).toHaveLength(1);
    expect(warnings).toEqual([]);
  });

  // ── Tool result edge cases ──

  it("converts tool result with error-json output", () => {
    const messages: ModelMessage[] = [
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call_error_json",
            toolName: "bash",
            output: {
              type: "error-json",
              value: { error: "Something broke", code: 500 },
            },
          } as any,
        ],
      },
    ];
    const { context, warnings } = convertToPiMessages(messages);
    expect(context.messages).toHaveLength(1);
    const toolMsg = context.messages[0] as any;
    expect(toolMsg.isError).toBe(true);
    expect(warnings).toEqual([]);
  });

  it("converts tool result with content type output", () => {
    const messages: ModelMessage[] = [
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call_content",
            toolName: "read",
            output: {
              type: "content",
              value: [
                { type: "text", text: "File line 1" },
                { type: "text", text: "File line 2" },
              ],
            },
          } as any,
        ],
      },
    ];
    const { context, warnings } = convertToPiMessages(messages);
    expect(context.messages).toHaveLength(1);
    const toolMsg = context.messages[0] as any;
    expect(toolMsg.role).toBe("toolResult");
    expect(toolMsg.isError).toBe(false);
    expect(warnings).toEqual([]);
  });

  // ── Assistant message edge cases ──

  it("skips assistant message with empty content array", () => {
    const messages: ModelMessage[] = [
      { role: "assistant", content: [] as any },
    ];
    const { context, warnings } = convertToPiMessages(messages);
    expect(context.messages).toHaveLength(0);
    expect(warnings).toEqual([]);
  });

  // ── Multiple tool results ──

  it("converts multiple tool results in one tool message", () => {
    const messages: ModelMessage[] = [
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call_001",
            toolName: "read",
            output: { type: "text", value: "Content A" },
          } as any,
          {
            type: "tool-result",
            toolCallId: "call_002",
            toolName: "grep",
            output: { type: "text", value: "Content B" },
          } as any,
        ],
      },
    ];
    const { context, warnings } = convertToPiMessages(messages);
    expect(context.messages).toHaveLength(2);
    expect(context.messages[0].role).toBe("toolResult");
    expect(context.messages[1].role).toBe("toolResult");
    expect(warnings).toEqual([]);
  });

  // ── Image objects ──

  it("converts user message with image object (not string URL)", () => {
    const messages: ModelMessage[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "Analyze" },
          {
            type: "image",
            image: { data: "base64data", mimeType: "image/jpeg" } as any,
          } as any,
        ],
      },
    ];
    const { context, warnings } = convertToPiMessages(messages);
    expect(context.messages).toHaveLength(1);
    expect(warnings).toEqual([]);
  });

  it("warns about image URL object in image part", () => {
    const messages: ModelMessage[] = [
      {
        role: "user",
        content: [
          {
            type: "image",
            image: new URL("https://example.com/photo.jpg"),
          } as any,
        ],
      },
    ];
    const { context: _context, warnings } = convertToPiMessages(messages);
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]).toContain("Image URLs are not supported");
  });
});

describe("buildPromptFromContext", () => {
  it("returns the last user message text", () => {
    const { context } = convertToPiMessages([
      { role: "user", content: "First message" },
      { role: "assistant", content: "Response" },
      { role: "user", content: "Second message" },
    ]);
    expect(buildPromptFromContext(context)).toBe("Second message");
  });

  it("returns empty string when there are no user messages", () => {
    const { context } = convertToPiMessages([
      { role: "assistant", content: "Hello" },
    ]);
    expect(buildPromptFromContext(context)).toBe("");
  });

  it("returns empty string for empty messages", () => {
    const { context } = convertToPiMessages([]);
    expect(buildPromptFromContext(context)).toBe("");
  });

  it("handles user message with content parts", () => {
    const { context } = convertToPiMessages([
      {
        role: "user",
        content: [
          { type: "text", text: "Line 1" },
          { type: "text", text: "Line 2" },
        ],
      },
    ]);
    const prompt = buildPromptFromContext(context);
    expect(prompt).toContain("Line 1");
    expect(prompt).toContain("Line 2");
  });
});
