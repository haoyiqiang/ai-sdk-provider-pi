/**
 * Error handling example using ai-sdk-provider-pi.
 *
 * Usage: npx tsx examples/error-handling.ts
 *
 * Note: This example demonstrates error types and guard functions.
 * Model-specific error handling (e.g., real API auth failures)
 * requires a valid API key via .env.
 */
import "dotenv/config";
import { APICallError, LoadAPIKeyError } from "@ai-sdk/provider";
import { generateText } from "ai";
import {
  getErrorMetadata,
  isAuthenticationError,
  isContextOverflowError,
  isTimeoutError,
  pi,
} from "../src/index.js";

const MODEL_ID = process.env.PI_MODEL_ID ?? "deepseek-v4-flash";

async function main() {
  console.log("=== Error Handling Examples ===\n");

  // Example 1: Invalid model ID
  console.log("1. Invalid model ID:");
  try {
    const model = pi("invalid-provider/nonexistent-model");
    await generateText({ model, prompt: "Hello" });
  } catch (error) {
    console.log(
      `   Caught: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`
    );
  }

  // Example 2: Empty model ID
  console.log("\n2. Empty model ID:");
  try {
    pi("");
  } catch (error) {
    console.log(
      `   Caught: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`
    );
  }

  // Example 3: Using error type guards
  console.log("\n3. Error type guards demo:");
  const fakeAuthError = new LoadAPIKeyError({ message: "API key not found" });
  const fakeTimeoutError = new APICallError({
    message: "Timeout",
    url: "pi://test",
    requestBodyValues: {},
    isRetryable: true,
    data: { code: "TIMEOUT" },
  });
  const fakeContextError = new APICallError({
    message: "Context overflow",
    url: "pi://test",
    requestBodyValues: {},
    isRetryable: false,
    data: { code: "CONTEXT_OVERFLOW" },
  });

  console.log(
    `   isAuthenticationError(fakeAuthError): ${isAuthenticationError(fakeAuthError)}`
  );
  console.log(
    `   isTimeoutError(fakeTimeoutError): ${isTimeoutError(fakeTimeoutError)}`
  );
  console.log(
    `   isContextOverflowError(fakeContextError): ${isContextOverflowError(fakeContextError)}`
  );

  // Example 4: Extract error metadata
  console.log("\n4. Error metadata extraction:");
  const errorWithMeta = new APICallError({
    message: "Something failed",
    url: "pi://anthropic/claude-sonnet-4",
    requestBodyValues: {},
    isRetryable: false,
    data: {
      code: "CUSTOM_ERROR",
      provider: "anthropic",
      modelId: "claude-sonnet-4",
      sessionId: "sess_abc123",
    },
  });
  const meta = getErrorMetadata(errorWithMeta);
  console.log(`   code: ${meta?.code}`);
  console.log(`   provider: ${meta?.provider}`);
  console.log(`   modelId: ${meta?.modelId}`);
  console.log(`   sessionId: ${meta?.sessionId}`);

  // Example 5: Real API call with error handling (requires .env config)
  console.log("\n5. Real API call with error handling:");
  try {
    const model = pi(MODEL_ID);
    const { text, finishReason } = await generateText({
      model,
      prompt: "用一句话说你好。",
    });
    console.log(`   Success: ${text}`);
    console.log(`   Finish reason: ${JSON.stringify(finishReason)}`);
    (model as any).dispose();
  } catch (error) {
    console.log(
      `   Caught: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`
    );
    if (isAuthenticationError(error)) {
      console.log("   → 请检查 .env 中的 API key 配置");
    } else if (isTimeoutError(error)) {
      console.log("   → 请求超时，请稍后重试");
    }
  }
}

main();
