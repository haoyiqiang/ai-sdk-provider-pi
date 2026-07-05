import { describe, expect, it } from "vitest";
import {
  parseModelId,
  validateModelAvailability,
  validateModelSettings,
  validateProviderSettings,
} from "../src/validation.js";

describe("parseModelId", () => {
  // ── Provider/Model format ──

  it('parses "anthropic/claude-sonnet-4" correctly', () => {
    const result = parseModelId("anthropic/claude-sonnet-4");
    expect(result).toEqual({
      provider: "anthropic",
      modelId: "claude-sonnet-4",
    });
  });

  it('parses "openai/gpt-4o" correctly', () => {
    const result = parseModelId("openai/gpt-4o");
    expect(result).toEqual({ provider: "openai", modelId: "gpt-4o" });
  });

  it('parses "google/gemini-2.5-pro" correctly', () => {
    const result = parseModelId("google/gemini-2.5-pro");
    expect(result).toEqual({ provider: "google", modelId: "gemini-2.5-pro" });
  });

  // ── Convenience aliases ──

  it('resolves "sonnet" alias', () => {
    const result = parseModelId("sonnet");
    expect(result).toEqual({
      provider: "anthropic",
      modelId: "claude-sonnet-4",
    });
  });

  it('resolves "opus" alias', () => {
    const result = parseModelId("opus");
    expect(result).toEqual({ provider: "anthropic", modelId: "claude-opus-4" });
  });

  it('resolves "haiku" alias', () => {
    const result = parseModelId("haiku");
    expect(result).toEqual({
      provider: "anthropic",
      modelId: "claude-haiku-4",
    });
  });

  it('resolves "gpt-4o" alias', () => {
    const result = parseModelId("gpt-4o");
    expect(result).toEqual({ provider: "openai", modelId: "gpt-4o" });
  });

  it('resolves "gpt-4o-mini" alias', () => {
    const result = parseModelId("gpt-4o-mini");
    expect(result).toEqual({ provider: "openai", modelId: "gpt-4o-mini" });
  });

  it('resolves "o3" alias', () => {
    const result = parseModelId("o3");
    expect(result).toEqual({ provider: "openai", modelId: "o3" });
  });

  it('resolves "o4-mini" alias', () => {
    const result = parseModelId("o4-mini");
    expect(result).toEqual({ provider: "openai", modelId: "o4-mini" });
  });

  it('resolves "gemini-2.5-pro" alias', () => {
    const result = parseModelId("gemini-2.5-pro");
    expect(result).toEqual({ provider: "google", modelId: "gemini-2.5-pro" });
  });

  it('resolves "gemini-2.5-flash" alias', () => {
    const result = parseModelId("gemini-2.5-flash");
    expect(result).toEqual({ provider: "google", modelId: "gemini-2.5-flash" });
  });

  it('resolves "deepseek-v4-flash" alias', () => {
    const result = parseModelId("deepseek-v4-flash");
    expect(result).toEqual({
      provider: "deepseek",
      modelId: "deepseek-v4-flash",
    });
  });

  it('resolves "deepseek-v4-pro" alias', () => {
    const result = parseModelId("deepseek-v4-pro");
    expect(result).toEqual({
      provider: "deepseek",
      modelId: "deepseek-v4-pro",
    });
  });

  it('resolves "deepseek-chat" alias (maps to deepseek-v4-flash)', () => {
    const result = parseModelId("deepseek-chat");
    expect(result).toEqual({
      provider: "deepseek",
      modelId: "deepseek-v4-flash",
    });
  });

  it('resolves "deepseek-reasoner" alias (maps to deepseek-v4-pro)', () => {
    const result = parseModelId("deepseek-reasoner");
    expect(result).toEqual({
      provider: "deepseek",
      modelId: "deepseek-v4-pro",
    });
  });

  it("aliases are case-insensitive", () => {
    const result = parseModelId("Sonnet");
    expect(result).toEqual({
      provider: "anthropic",
      modelId: "claude-sonnet-4",
    });
  });

  // ── Error cases ──

  it("throws for empty string", () => {
    expect(() => parseModelId("")).toThrow("Model ID cannot be empty");
  });

  it("throws for whitespace-only string", () => {
    expect(() => parseModelId("   ")).toThrow("Model ID cannot be empty");
  });

  it("throws for malformed provider/model format with too many slashes", () => {
    expect(() => parseModelId("a/b/c")).toThrow("Invalid model ID format");
  });

  it("throws for malformed format with empty provider", () => {
    expect(() => parseModelId("/model")).toThrow("Invalid model ID format");
  });

  it("throws for malformed format with empty model ID", () => {
    expect(() => parseModelId("provider/")).toThrow("Invalid model ID format");
  });

  it("throws for unknown alias", () => {
    expect(() => parseModelId("unknown-model")).toThrow("Unknown model alias");
  });
});

describe("validateProviderSettings", () => {
  it("returns no warnings for default settings", () => {
    const result = validateProviderSettings({});
    expect(result.warnings).toEqual([]);
  });

  it("warns about verbose logging", () => {
    const result = validateProviderSettings({ verbose: true });
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("Verbose");
  });
});

describe("validateModelSettings", () => {
  it("returns no warnings for default settings", () => {
    const result = validateModelSettings({});
    expect(result.warnings).toEqual([]);
  });

  it("warns about high maxTurns", () => {
    const result = validateModelSettings({ maxTurns: 100 });
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("High maxTurns");
  });

  it("does not warn about reasonable maxTurns", () => {
    const result = validateModelSettings({ maxTurns: 10 });
    expect(result.warnings).toEqual([]);
  });

  it("warns about both tools and excludeTools", () => {
    const result = validateModelSettings({
      tools: ["bash"],
      excludeTools: ["edit"],
    });
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("tools and excludeTools");
  });
});

describe("validateModelAvailability", () => {
  it("returns warning when model is not found in registry", () => {
    const registry = {
      find: () => undefined,
      hasConfiguredAuth: () => false,
    };
    const result = validateModelAvailability(
      "anthropic",
      "unknown-model",
      registry
    );
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("not found");
    expect(result.model).toBeUndefined();
  });

  it("returns warning when API key is not configured", () => {
    const fakeModel = { id: "claude-sonnet-4", provider: "anthropic" } as any;
    const registry = {
      find: () => fakeModel,
      hasConfiguredAuth: () => false,
    };
    const result = validateModelAvailability(
      "anthropic",
      "claude-sonnet-4",
      registry
    );
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("No API key");
    expect(result.model).toBe(fakeModel);
  });

  it("returns no warnings when model is found and auth is configured", () => {
    const fakeModel = { id: "claude-sonnet-4", provider: "anthropic" } as any;
    const registry = {
      find: () => fakeModel,
      hasConfiguredAuth: () => true,
    };
    const result = validateModelAvailability(
      "anthropic",
      "claude-sonnet-4",
      registry
    );
    expect(result.warnings).toEqual([]);
    expect(result.model).toBe(fakeModel);
  });
});
