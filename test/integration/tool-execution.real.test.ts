import { describe, expect, it } from "vitest";
import { createPi } from "../../src/index.js";

const runIntegration = process.env.PI_INTEGRATION_TEST === "true";
const test = runIntegration ? it : it.skip;

function extractText(content: Array<{ type: string; text?: string }>): string {
  return content
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("");
}

describe.runIf(runIntegration)("Real tool execution", () => {
  test("executes a tool call (read package.json)", async () => {
    const pi = createPi({ cwd: process.cwd() });
    const model = pi("deepseek-v4-flash");
    try {
      const { content } = await model.doGenerate({
        prompt: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "Use read tool to read package.json in current directory. What is the project name?",
              },
            ],
          },
        ],
      });
      const text = extractText(content);
      expect(text).toBeTruthy();
      expect(text.toLowerCase()).toContain("@haoyiqiang/ai-sdk-provider-pi");
    } finally {
      (model as any).dispose();
    }
  });

  test("works with noTools option", async () => {
    const pi = createPi({ noTools: "all" });
    const model = pi("deepseek-v4-flash");
    try {
      const { content } = await model.doGenerate({
        prompt: [
          {
            role: "user",
            content: [{ type: "text", text: "Say hello world" }],
          },
        ],
      });
      const text = extractText(content);
      expect(text).toBeTruthy();
    } finally {
      (model as any).dispose();
    }
  });
});
