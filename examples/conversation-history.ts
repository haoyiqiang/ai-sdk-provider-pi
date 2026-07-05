/**
 * Multi-turn conversation example using ai-sdk-provider-pi.
 *
 * Demonstrates:
 *   - Multi-turn conversation with messages array
 *   - System prompt across turns
 *   - Manual construction of ModelMessage for history
 *
 * Usage: cp .env.example .env  # 配置 PI_MODEL_ID 和 API key
 *        npx tsx examples/conversation-history.ts
 */
import "dotenv/config";
import type { ModelMessage } from "ai";
import { generateText } from "ai";
import { pi } from "../src/index.js";

const MODEL_ID = process.env.PI_MODEL_ID ?? "deepseek-v4-flash";

async function main() {
  const model = pi(MODEL_ID);

  try {
    // Turn 1: Establish context
    console.log("=== Multi-Turn Conversation ===\n");

    const turn1Result = await generateText({
      model,
      messages: [
        {
          role: "system",
          content: "你是一个友好的助手。请用简洁的中文回答。",
        },
        {
          role: "user",
          content: [{ type: "text", text: "我的名字是张三。" }],
        },
      ],
    });

    const assistantReply = turn1Result.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("");

    console.log("Turn 1:");
    console.log("  User: 我的名字是张三。");
    console.log(`  Assistant: ${assistantReply}`);
    console.log(
      `  Tokens: in=${turn1Result.usage.inputTokens ?? "N/A"}, out=${turn1Result.usage.outputTokens ?? "N/A"}`
    );
    console.log();

    // Turn 2: Follow-up (session is reused automatically)
    const messages: ModelMessage[] = [
      { role: "system", content: "你是一个友好的助手。请用简洁的中文回答。" },
      { role: "user", content: "我的名字是张三。" },
      { role: "assistant", content: assistantReply },
      { role: "user", content: "你还记得我的名字吗？" },
    ];

    const turn2Result = await generateText({
      model,
      messages,
    });

    const reply2 = turn2Result.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("");

    console.log("Turn 2:");
    console.log("  User: 你还记得我的名字吗？");
    console.log(`  Assistant: ${reply2}`);
    console.log(
      `  Tokens: in=${turn2Result.usage.inputTokens ?? "N/A"}, out=${turn2Result.usage.outputTokens ?? "N/A"}`
    );
  } catch (error) {
    console.error("Error:", error);
  } finally {
    (model as any).dispose();
  }
}

main();
