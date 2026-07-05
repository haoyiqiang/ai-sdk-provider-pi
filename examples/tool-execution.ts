/**
 * Tool execution example using @kevinhao/ai-sdk-provider-pi.
 *
 * Demonstrates:
 *   - Tool execution (Pi reads files, runs commands)
 *   - noTools option (disabling all tools)
 *
 * Usage: cp .env.example .env  # 配置 PI_MODEL_ID 和 API key
 *        npx tsx examples/tool-execution.ts
 */
import "dotenv/config";
import { generateText } from "ai";
import { createPi } from "../src/index.js";

const MODEL_ID = process.env.PI_MODEL_ID ?? "deepseek-v4-flash";

async function main() {
  // ── Part 1: Tool execution ──
  const pi = createPi({
    cwd: process.cwd(),
  });

  const model = pi(MODEL_ID);

  try {
    console.log("=== Tool Execution Example ===\n");
    console.log("Asking Pi to read package.json...\n");

    const { text, finishReason, usage, warnings } = await generateText({
      model,
      prompt:
        "使用 read 工具读取当前目录的 package.json 文件，然后告诉我这个项目的名称和版本号。",
    });

    console.log("=== Response ===");
    console.log(text);
    console.log();

    console.log("=== Usage ===");
    console.log(`Input tokens:  ${usage.inputTokens ?? "N/A"}`);
    console.log(`Output tokens: ${usage.outputTokens ?? "N/A"}`);
    console.log();

    console.log("=== Finish Reason ===");
    console.log(JSON.stringify(finishReason, null, 2));

    if (warnings != null && warnings.length > 0) {
      console.log();
      console.log("=== Warnings ===");
      for (const w of warnings) {
        console.log(
          `  - ${w.type}: ${"message" in w ? w.message : (w.details ?? "no details")}`,
        );
      }
    }
  } catch (error) {
    console.error("Error:", error);
  } finally {
    (model as any).dispose();
  }

  // ── Part 2: NoTools example ──
  console.log("\n---\n");

  const noToolsPi = createPi({ noTools: "all" });
  const noToolsModel = noToolsPi(MODEL_ID);

  try {
    console.log("=== No-Tools Example ===\n");
    console.log("Asking Pi without tools...\n");

    const { text, usage } = await generateText({
      model: noToolsModel,
      prompt: "用一句话解释什么是 DevOps。",
    });

    console.log("=== Response ===");
    console.log(text);
    console.log();

    console.log("=== Usage ===");
    console.log(`Input tokens:  ${usage.inputTokens ?? "N/A"}`);
    console.log(`Output tokens: ${usage.outputTokens ?? "N/A"}`);
  } catch (error) {
    console.error("Error:", error);
  } finally {
    (noToolsModel as any).dispose();
  }
}

main();
