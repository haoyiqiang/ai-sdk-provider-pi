import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_TOOL_RESULT_SIZE,
  mapPiToolCall,
  mapPiToolResult,
  safeStringify,
  truncateJsonValue,
} from "../src/tool-mapper.js";

// ─── safeStringify ───

describe("safeStringify", () => {
  it("stringifies a plain object", () => {
    const result = safeStringify({ a: 1, b: "two" });
    expect(result).toBe('{"a":1,"b":"two"}');
  });

  it("stringifies a primitive string", () => {
    const result = safeStringify("hello");
    expect(result).toBe('"hello"');
  });

  it("stringifies a number", () => {
    const result = safeStringify(42);
    expect(result).toBe("42");
  });

  it("stringifies null", () => {
    const result = safeStringify(null);
    expect(result).toBe("null");
  });

  it("handles BigInt values by converting to string", () => {
    const result = safeStringify({ value: BigInt(123) });
    const parsed = JSON.parse(result);
    expect(parsed.value).toBe("123");
  });

  it("handles nested BigInt values", () => {
    const result = safeStringify({ nested: { big: BigInt(456) } });
    const parsed = JSON.parse(result);
    expect(parsed.nested.big).toBe("456");
  });

  it("handles circular references gracefully", () => {
    const obj: Record<string, unknown> = { name: "test" };
    obj.self = obj;
    const result = safeStringify(obj);
    expect(result).toContain("[Circular]");
    expect(result).toContain('"name":"test"');
  });

  it("handles deeply nested circular references", () => {
    const parent: Record<string, unknown> = { child: {} };
    const child = { parent };
    parent.child = child;
    const result = safeStringify(parent);
    expect(result).toContain("[Circular]");
  });

  it("returns String(value) for unstringifiable values", () => {
    // Function is not JSON-serializable
    const fn = () => "test";
    const result = safeStringify(fn);
    expect(typeof result).toBe("string");
    expect(result).toContain("test");
  });

  it("handles undefined gracefully", () => {
    // undefined values are omitted from JSON
    const result = safeStringify({ a: 1, b: undefined });
    expect(result).toBe('{"a":1}');
  });
});

// ─── truncateJsonValue ───

describe("truncateJsonValue", () => {
  it("returns full preview when under maxSize", () => {
    const result = truncateJsonValue("short", 100);
    expect(result.truncated).toBe(false);
    expect(result.maxSize).toBe(100);
    expect(result.preview).toBe("short");
  });

  it("stringifies objects for truncation", () => {
    const result = truncateJsonValue({ key: "value" }, 100);
    expect(result.truncated).toBe(false);
    expect(result.preview).toBe('{"key":"value"}');
  });

  it("truncates when over maxSize", () => {
    const longText = "a".repeat(100);
    const result = truncateJsonValue(longText, 50);
    expect(result.truncated).toBe(true);
    expect(result.maxSize).toBe(50);
    expect(result.preview).toContain("[truncated");
    expect(result.preview).toContain("chars]");
    expect(result.preview.length).toBeLessThan(longText.length);
  });

  it("handles exactly-at-boundary case", () => {
    const text = "a".repeat(10);
    const result = truncateJsonValue(text, 10);
    expect(result.truncated).toBe(false);
    expect(result.preview).toBe(text);
  });

  it("handles very small maxSize", () => {
    const text = "hello world";
    const result = truncateJsonValue(text, 3);
    expect(result.truncated).toBe(true);
    expect(result.preview).toContain("[truncated");
  });

  it("returns correct preview for truncated values", () => {
    const text = "hello world";
    const result = truncateJsonValue(text, 5);
    expect(result.truncated).toBe(true);
    expect(result.preview).toBe("hello...[truncated 6 chars]");
  });

  it("does not double-stringify already-string values", () => {
    const result = truncateJsonValue("plain text", 100);
    expect(result.preview).toBe("plain text");
    // Not '"plain text"' (no JSON quotes around string)
  });
});

// ─── mapPiToolCall ───

describe("mapPiToolCall", () => {
  it("maps a tool call with string arguments", () => {
    const result = mapPiToolCall({
      id: "tc_1",
      name: "read",
      arguments: '{"path":"/tmp/test.txt"}',
    });
    expect(result.type).toBe("tool-call");
    expect(result.toolCallId).toBe("tc_1");
    expect(result.toolName).toBe("read");
    expect(result.input).toBe('{"path":"/tmp/test.txt"}');
  });

  it("maps a tool call with object arguments using safeStringify", () => {
    const result = mapPiToolCall({
      id: "tc_2",
      name: "bash",
      arguments: { command: "ls", cwd: "/tmp" },
    });
    expect(result.type).toBe("tool-call");
    expect(result.toolCallId).toBe("tc_2");
    expect(result.toolName).toBe("bash");
    expect(result.input).toBe('{"command":"ls","cwd":"/tmp"}');
  });

  it("falls back to unknown_tool when name is empty", () => {
    const result = mapPiToolCall({
      id: "tc_3",
      name: "",
      arguments: "{}",
    });
    expect(result.toolName).toBe("unknown_tool");
  });

  it("handles BigInt in arguments", () => {
    const result = mapPiToolCall({
      id: "tc_4",
      name: "test",
      arguments: { count: BigInt(42) },
    });
    expect(result.input).toContain('"42"');
  });
});

// ─── mapPiToolResult ───

describe("mapPiToolResult", () => {
  it("maps a string tool result", () => {
    const result = mapPiToolResult({
      toolCallId: "tc_1",
      toolName: "read",
      result: "file contents here",
    });
    expect(result.type).toBe("tool-result");
    expect(result.toolCallId).toBe("tc_1");
    expect(result.toolName).toBe("read");
    expect(result.result).toBe("file contents here");
    expect(result.isError).toBeUndefined();
    expect(result.dynamic).toBe(true);
  });

  it("maps an object tool result using safeStringify", () => {
    const result = mapPiToolResult({
      toolCallId: "tc_2",
      toolName: "bash",
      result: { stdout: "output", stderr: "" },
    });
    expect(result.toolCallId).toBe("tc_2");
    expect(result.toolName).toBe("bash");
    expect(result.result).toBe('{"stdout":"output","stderr":""}');
    expect(result.isError).toBeUndefined();
  });

  it("preserves isError flag", () => {
    const result = mapPiToolResult({
      toolCallId: "tc_3",
      toolName: "bash",
      result: "command failed",
      isError: true,
    });
    expect(result.isError).toBe(true);
  });

  it("maps a null result to empty string", () => {
    const result = mapPiToolResult({
      toolCallId: "tc_4",
      toolName: "test",
      result: null,
    });
    expect(result.result).toBe('""');
  });

  it("truncates large results", () => {
    const longResult = "x".repeat(200);
    const result = mapPiToolResult(
      {
        toolCallId: "tc_5",
        toolName: "read",
        result: longResult,
      },
      50,
    );
    expect(typeof result.result).toBe("string");
    expect((result.result as string).length).toBeLessThan(longResult.length);
    expect(result.result).toContain("[truncated");
  });

  it("uses DEFAULT_MAX_TOOL_RESULT_SIZE when maxResultSize not provided", () => {
    const result = mapPiToolResult({
      toolCallId: "tc_6",
      toolName: "test",
      result: "short",
    });
    expect(result.result).toBe("short");
  });

  it("handles BigInt in result", () => {
    const result = mapPiToolResult({
      toolCallId: "tc_7",
      toolName: "test",
      result: { value: BigInt(999) },
    });
    expect(result.result).toContain('"999"');
  });
});

// ─── DEFAULT_MAX_TOOL_RESULT_SIZE ───

describe("DEFAULT_MAX_TOOL_RESULT_SIZE", () => {
  it("is 10_000", () => {
    expect(DEFAULT_MAX_TOOL_RESULT_SIZE).toBe(10_000);
  });
});
