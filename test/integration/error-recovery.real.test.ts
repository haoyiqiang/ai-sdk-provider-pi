import { NoSuchModelError } from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import { pi } from "../../src/index.js";

const runIntegration = process.env.PI_INTEGRATION_TEST === "true";
const test = runIntegration ? it : it.skip;

describe.runIf(runIntegration)("Real error scenarios", () => {
  test("invalid model ID throws NoSuchModelError", () => {
    expect(() => pi("nonexistent/unknown-model-12345")).toThrow(
      NoSuchModelError
    );
  });

  test("empty model ID throws", () => {
    expect(() => pi("")).toThrow();
  });

  test("invalid API key throws an error", async () => {
    const model = pi("deepseek-v4-flash");
    try {
      // Temporarily make env var invalid
      const originalKey = process.env.DEEPSEEK_API_KEY;
      process.env.DEEPSEEK_API_KEY = "sk-invalid-key-for-test";
      try {
        await model.doGenerate({
          prompt: [
            { role: "user", content: [{ type: "text", text: "hello" }] },
          ],
        });
        expect.unreachable("should have thrown");
      } catch {
        // expected
      } finally {
        process.env.DEEPSEEK_API_KEY = originalKey;
      }
    } finally {
      (model as any).dispose();
    }
  });

  test("abort signal works with pre-abort", async () => {
    const model = pi("deepseek-v4-flash");
    const abortController = new AbortController();
    abortController.abort(); // pre-abort
    try {
      await model.doGenerate({
        prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
        abortSignal: abortController.signal,
      });
      expect.unreachable("should have thrown due to pre-abort");
    } catch {
      // expected
    } finally {
      (model as any).dispose();
    }
  });
});
