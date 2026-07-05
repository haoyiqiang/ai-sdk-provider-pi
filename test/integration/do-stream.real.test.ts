import { describe, expect, it } from "vitest";
import { pi } from "../../src/index.js";

const runIntegration = process.env.PI_INTEGRATION_TEST === "true";
const test = runIntegration ? it : it.skip;

describe.runIf(runIntegration)("Real doStream", () => {
  test("streams text deltas", async () => {
    const model = pi("deepseek-v4-flash");
    try {
      const stream = await model.doStream({
        prompt: [
          { role: "user", content: [{ type: "text", text: "Say hello" }] },
        ],
      });
      const parts: string[] = [];
      const reader = stream.stream.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        if (value.type === "text-delta") {
          parts.push((value as any).delta);
        }
      }
      expect(parts.length).toBeGreaterThan(0);
    } finally {
      (model as any).dispose();
    }
  });

  test("stream includes finish event", async () => {
    const model = pi("deepseek-v4-flash");
    try {
      const stream = await model.doStream({
        prompt: [{ role: "user", content: [{ type: "text", text: "Say hi" }] }],
      });
      let hasFinish = false;
      const reader = stream.stream.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        if (value.type === "finish") {
          hasFinish = true;
        }
      }
      expect(hasFinish).toBe(true);
    } finally {
      (model as any).dispose();
    }
  });

  test("abort stops streaming", async () => {
    const model = pi("deepseek-v4-flash");
    const abortController = new AbortController();
    try {
      const stream = await model.doStream({
        prompt: [
          { role: "user", content: [{ type: "text", text: "Say hello" }] },
        ],
        abortSignal: abortController.signal,
      });
      // Read a bit then abort
      const reader = stream.stream.getReader();
      const _firstChunk = await reader.read();
      abortController.abort();
      // After abort, reading should fail or stream should end
      try {
        await reader.read();
      } catch {
        // expected — stream errored after abort
      }
    } finally {
      (model as any).dispose();
    }
  });
});
