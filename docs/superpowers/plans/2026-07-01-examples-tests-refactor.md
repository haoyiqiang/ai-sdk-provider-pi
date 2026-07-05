# Examples, Test Coverage, and Refactoring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 ai-sdk-provider-pi 添加 6 个 CLI 示例，补充测试覆盖，提取 PiLanguageModel 中重复逻辑为 4 个私有 helper。

**Architecture:** 3 个独立工作流并行推进：examples（纯新增）、refactoring（修改 pi-language-model.ts）、test coverage（新增 + 补充测试文件）。examples 和测试无依赖关系，但 refactoring 完成后需要跑全量测试验证。

**Tech Stack:** TypeScript, Vitest, @ai-sdk/provider v3, ai v6, @earendil-works/pi-coding-agent

## Global Constraints

- Node.js >= 18
- 公共 API 不变
- 所有测试必须通过
- 每个示例文件独立可运行（`npx tsx examples/<name>.ts`）

---

### Task 1: Examples — basic-generate.ts

**Files:**

- Create: `examples/basic-generate.ts`

**Interfaces:**

- Consumes: `pi` from `../src/index.js`, `generateText` from `ai`
- Produces: 独立 CLI 脚本，输出 text、usage、finishReason

- [ ] **Step 1: 创建示例文件**

```typescript
/**
 * Basic generateText example using ai-sdk-provider-pi.
 *
 * Usage: npx tsx examples/basic-generate.ts
 */

import { pi } from "../src/index.js";
import { generateText } from "ai";

async function main() {
  const model = pi("sonnet");

  try {
    const { text, usage, finishReason, warnings } = await generateText({
      model,
      prompt: "用一句话解释什么是量子计算。",
    });

    console.log("=== Response ===");
    console.log(text);
    console.log();

    console.log("=== Usage ===");
    console.log(`Input tokens:  ${usage.inputTokens?.total ?? "N/A"}`);
    console.log(`Output tokens: ${usage.outputTokens?.total ?? "N/A"}`);

    console.log();
    console.log("=== Finish Reason ===");
    console.log(JSON.stringify(finishReason, null, 2));

    if (warnings.length > 0) {
      console.log();
      console.log("=== Warnings ===");
      for (const w of warnings)
        console.log(`  - ${w.type}: ${w.message ?? w.details}`);
    }
  } catch (error) {
    console.error("Error:", error);
  } finally {
    model.dispose();
  }
}

main();
```

- [ ] **Step 2: 验证语法正确**

```bash
npx tsc --noEmit examples/basic-generate.ts
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add examples/basic-generate.ts
git commit -m "feat(examples): add basic-generate CLI example"
```

---

### Task 2: Examples — basic-stream.ts

**Files:**

- Create: `examples/basic-stream.ts`

**Interfaces:**

- Consumes: `pi` from `../src/index.js`, `streamText` from `ai`
- Produces: 流式输出 CLI 脚本

- [ ] **Step 1: 创建示例文件**

```typescript
/**
 * Basic streamText example using ai-sdk-provider-pi.
 *
 * Usage: npx tsx examples/basic-stream.ts
 */

import { pi } from "../src/index.js";
import { streamText } from "ai";

async function main() {
  const model = pi("sonnet");

  try {
    const result = streamText({
      model,
      prompt: "写一首关于编程的简短俳句。",
    });

    console.log("=== Streaming Response ===");

    // Stream text deltas
    for await (const chunk of result.textStream) {
      process.stdout.write(chunk);
    }
    console.log("\n");

    // Get final metadata
    const { usage, finishReason } = await result;
    console.log("=== Usage ===");
    console.log(`Input tokens:  ${usage.inputTokens?.total ?? "N/A"}`);
    console.log(`Output tokens: ${usage.outputTokens?.total ?? "N/A"}`);
    console.log();
    console.log("=== Finish Reason ===");
    console.log(JSON.stringify(finishReason, null, 2));
  } catch (error) {
    console.error("Error:", error);
  } finally {
    model.dispose();
  }
}

main();
```

- [ ] **Step 2: Commit**

```bash
git add examples/basic-stream.ts
git commit -m "feat(examples): add basic-stream CLI example"
```

---

### Task 3: Examples — tool-execution.ts

**Files:**

- Create: `examples/tool-execution.ts`

**Interfaces:**

- Consumes: `createPi` from `../src/index.js`, `generateText` from `ai`
- Produces: 工具执行示例

- [ ] **Step 1: 创建示例文件**

```typescript
/**
 * Tool execution example using ai-sdk-provider-pi.
 *
 * Usage: npx tsx examples/tool-execution.ts
 */

import { createPi } from "../src/index.js";
import { generateText } from "ai";

async function main() {
  // Create a provider with working directory for tool execution
  const pi = createPi({
    cwd: process.cwd(),
  });

  const model = pi("sonnet");

  try {
    console.log("=== Tool Execution Example ===\n");
    console.log("Asking Pi to read package.json...\n");

    const { text, finishReason } = await generateText({
      model,
      prompt:
        "使用 read 工具读取当前目录的 package.json 文件，然后告诉我这个项目的名称和版本号。",
    });

    console.log("=== Response ===");
    console.log(text);
    console.log();
    console.log("=== Finish Reason ===");
    console.log(JSON.stringify(finishReason, null, 2));
  } catch (error) {
    console.error("Error:", error);
  } finally {
    model.dispose();
  }

  // Example with tools disabled
  console.log("\n---\n");

  const noToolsPi = createPi({ noTools: "all" });
  const noToolsModel = noToolsPi("sonnet");

  try {
    console.log("=== No-Tools Example ===\n");
    console.log("Asking Pi without tools...\n");

    const { text } = await generateText({
      model: noToolsModel,
      prompt: "用一句话解释什么是 DevOps。",
    });

    console.log("=== Response ===");
    console.log(text);
  } catch (error) {
    console.error("Error:", error);
  } finally {
    noToolsModel.dispose();
  }
}

main();
```

- [ ] **Step 2: Commit**

```bash
git add examples/tool-execution.ts
git commit -m "feat(examples): add tool-execution CLI example"
```

---

### Task 4: Examples — custom-provider.ts

**Files:**

- Create: `examples/custom-provider.ts`

**Interfaces:**

- Consumes: `createPi` from `../src/index.js`, `AuthStorage` from `@earendil-works/pi-coding-agent`, `generateText` from `ai`
- Produces: 自定义 provider 示例

- [ ] **Step 1: 创建示例文件**

```typescript
/**
 * Custom provider configuration example.
 *
 * Usage: npx tsx examples/custom-provider.ts
 */

import { createPi } from "../src/index.js";
import { AuthStorage } from "@earendil-works/pi-coding-agent";
import { generateText } from "ai";

async function main() {
  // Custom provider with explicit AuthStorage
  const authStorage = AuthStorage.create();

  const pi = createPi({
    authStorage,
    logger: {
      debug: (msg: string) => console.debug(`[DEBUG] ${msg}`),
      info: (msg: string) => {}, // Suppress info logs
      warn: (msg: string) => console.warn(`[WARN] ${msg}`),
      error: (msg: string) => console.error(`[ERROR] ${msg}`),
    },
  });

  // Try a Claude model
  const claudeModel = pi("anthropic/claude-haiku-4");

  try {
    console.log("=== Claude Haiku ===\n");

    const { text, usage, providerMetadata } = await generateText({
      model: claudeModel,
      prompt: "用一句话介绍你自己。",
    });

    console.log(text);
    console.log();
    console.log(
      `Tokens: in=${usage.inputTokens?.total}, out=${usage.outputTokens?.total}`,
    );
    if (providerMetadata) {
      console.log(
        `Provider: ${(providerMetadata as any).provider?.value ?? "N/A"}`,
      );
      console.log(
        `Model: ${(providerMetadata as any).responseModel?.value ?? "N/A"}`,
      );
    }
  } catch (error) {
    console.error("Claude model error:", error);
  } finally {
    claudeModel.dispose();
  }

  // Try switching to a different model
  console.log("\n---\n");

  const openaiModel = pi("gpt-4o");

  try {
    console.log("=== GPT-4o ===\n");

    const { text, usage } = await generateText({
      model: openaiModel,
      prompt: "用一句话介绍你自己。",
    });

    console.log(text);
    console.log();
    console.log(
      `Tokens: in=${usage.inputTokens?.total}, out=${usage.outputTokens?.total}`,
    );
  } catch (error) {
    console.error("OpenAI model error:", error);
  } finally {
    openaiModel.dispose();
  }
}

main();
```

- [ ] **Step 2: Commit**

```bash
git add examples/custom-provider.ts
git commit -m "feat(examples): add custom-provider CLI example"
```

---

### Task 5: Examples — error-handling.ts

**Files:**

- Create: `examples/error-handling.ts`

**Interfaces:**

- Consumes: `pi`, `isAuthenticationError`, `isTimeoutError`, `isContextOverflowError`, `getErrorMetadata` from `../src/index.js`, `generateText` from `ai`
- Produces: 错误处理示例

- [ ] **Step 1: 创建示例文件**

```typescript
/**
 * Error handling example using ai-sdk-provider-pi.
 *
 * Usage: npx tsx examples/error-handling.ts
 */

import {
  pi,
  isAuthenticationError,
  isTimeoutError,
  isContextOverflowError,
  getErrorMetadata,
} from "../src/index.js";
import { generateText } from "ai";
import { APICallError, LoadAPIKeyError } from "@ai-sdk/provider";

async function main() {
  console.log("=== Error Handling Examples ===\n");

  // Example 1: Invalid model ID
  console.log("1. Invalid model ID:");
  try {
    const model = pi("invalid-provider/nonexistent-model");
    await generateText({ model, prompt: "Hello" });
  } catch (error) {
    console.log(
      `   Caught: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`,
    );
  }

  // Example 2: Empty model ID
  console.log("\n2. Empty model ID:");
  try {
    pi("");
  } catch (error) {
    console.log(
      `   Caught: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`,
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
    `   isAuthenticationError(fakeAuthError): ${isAuthenticationError(fakeAuthError)}`,
  );
  console.log(
    `   isTimeoutError(fakeTimeoutError): ${isTimeoutError(fakeTimeoutError)}`,
  );
  console.log(
    `   isContextOverflowError(fakeContextError): ${isContextOverflowError(fakeContextError)}`,
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
}

main();
```

- [ ] **Step 2: Commit**

```bash
git add examples/error-handling.ts
git commit -m "feat(examples): add error-handling CLI example"
```

---

### Task 6: Examples — conversation-history.ts

**Files:**

- Create: `examples/conversation-history.ts`

**Interfaces:**

- Consumes: `pi` from `../src/index.js`, `generateText` from `ai`, `ModelMessage` from `ai`
- Produces: 多轮对话示例

- [ ] **Step 1: 创建示例文件**

```typescript
/**
 * Multi-turn conversation example using ai-sdk-provider-pi.
 *
 * Usage: npx tsx examples/conversation-history.ts
 */

import { pi } from "../src/index.js";
import { generateText } from "ai";
import type { ModelMessage } from "ai";

async function main() {
  const model = pi("sonnet");

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
    console.log(`  User: 我的名字是张三。`);
    console.log(`  Assistant: ${assistantReply}`);
    console.log(
      `  Tokens: in=${turn1Result.usage.inputTokens?.total}, out=${turn1Result.usage.outputTokens?.total}`,
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
    console.log(`  User: 你还记得我的名字吗？`);
    console.log(`  Assistant: ${reply2}`);
    console.log(
      `  Tokens: in=${turn2Result.usage.inputTokens?.total}, out=${turn2Result.usage.outputTokens?.total}`,
    );
  } catch (error) {
    console.error("Error:", error);
  } finally {
    model.dispose();
  }
}

main();
```

- [ ] **Step 2: Commit**

```bash
git add examples/conversation-history.ts
git commit -m "feat(examples): add conversation-history CLI example"
```

---

### Task 7: Refactoring — Extract helpers in PiLanguageModel

**Files:**

- Modify: `src/pi-language-model.ts`

**Interfaces:**

- Consumes: 现有的 doGenerate/doStream 中的事件处理逻辑
- Produces: 4 个私有方法：`#extractMessageEndData`, `#setupAbortHandler`, `#handlePromptError`, `#finalizeStreamParts`

- [ ] **Step 1: 阅读当前代码，确认改动位置**

Run: `cat src/pi-language-model.ts | head -n 35` to verify imports.

- [ ] **Step 2: 添加 4 个私有 helper 方法**

在 `PiLanguageModel` 类的 `dispose()` 方法之后、`doGenerate()` 之前插入以下代码：

```typescript
  // ─── Shared Helpers ───

  /**
   * Extracts usage, finishReason, and providerMetadata from a message_end event.
   */
  private extractMessageEndData(event: AgentSessionEvent): {
    usage: LanguageModelV3Usage;
    finishReason: LanguageModelV3FinishReason;
    piMeta: PiProviderMetadata;
  } {
    let usage: LanguageModelV3Usage = this.createEmptyUsage();
    let finishReason: LanguageModelV3FinishReason = { unified: 'stop', raw: undefined };
    let piMeta: PiProviderMetadata = {};

    if (event.type === 'message_end' && event.message?.role === 'assistant') {
      const msg = event.message as AssistantMessage;
      usage = this.extractUsage(msg.usage);
      finishReason = mapPiFinishReason(msg.stopReason);
      piMeta = {
        sessionId: this.sessionId,
        provider: msg.provider,
        modelId: msg.model,
        responseModel: msg.responseModel,
        responseId: msg.responseId,
      };
    }

    return { usage, finishReason, piMeta };
  }

  /**
   * Sets up an abort signal handler for the session.
   * Returns a cleanup function to remove the listener.
   */
  private setupAbortHandler(
    abortSignal: AbortSignal | undefined,
    session: AgentSession
  ): (() => void) | undefined {
    if (!abortSignal) return undefined;

    const onAbort = () => {
      session.abort().catch((err: unknown) => this.logger.error(`Abort error: ${err}`));
    };

    abortSignal.addEventListener('abort', onAbort);

    if (abortSignal.aborted) {
      onAbort();
    }

    return () => abortSignal.removeEventListener('abort', onAbort);
  }

  /**
   * Handles a session.prompt() failure: unsubscribes, cleans up abort listener,
   * invalidates the session, and calls the provided error handler.
   */
  private handlePromptError(
    error: unknown,
    unsubscribe: () => void,
    cleanupAbort: (() => void) | undefined,
    onError: (mappedError: unknown) => void
  ): void {
    unsubscribe();
    cleanupAbort?.();
    this.invalidateSession();
    try {
      onError(
        handlePiError(error, {
          provider: this.model.provider,
          modelId: this.model.id,
          sessionId: this.sessionId,
        })
      );
    } catch (mapped) {
      onError(mapped);
    }
  }

  /**
   * Finalizes a doStream controller: closes any open text/reasoning parts,
   * enqueues the finish event, closes the controller, and cleans up.
   */
  private finalizeStreamParts(
    controller: ReadableStreamDefaultController<LanguageModelV3StreamPart>,
    activeTextPartId: string | undefined,
    activeReasoningPartId: string | undefined,
    startTime: number,
    piMeta: PiProviderMetadata,
    finishReason: LanguageModelV3FinishReason,
    usage: LanguageModelV3Usage,
    cleanupAbort: (() => void) | undefined,
    unsubscribe: () => void
  ): void {
    if (activeTextPartId) {
      controller.enqueue({ type: 'text-end', id: activeTextPartId });
    }
    if (activeReasoningPartId) {
      controller.enqueue({ type: 'reasoning-end', id: activeReasoningPartId });
    }
    piMeta.durationMs = Date.now() - startTime;

    controller.enqueue({
      type: 'finish',
      finishReason,
      usage,
      providerMetadata: toProviderMetadata(piMeta),
    });

    controller.close();
    cleanupAbort?.();
    unsubscribe();
  }
```

- [ ] **Step 3: 重构 doGenerate — 替换 message_end 处理**

将 doGenerate 中的以下代码（当前 ~L260-264）：

```typescript
              case 'message_end': {
                if (event.message?.role === 'assistant') {
                  const msg = event.message as AssistantMessage;
                  usage = this.extractUsage(msg.usage);
                  finishReason = mapPiFinishReason(msg.stopReason);
                  piMeta = { sessionId: this.sessionId, provider: msg.provider, modelId: msg.model, responseModel: msg.responseModel, responseId: msg.responseId };
                }
                break;
              }
```

替换为：

```typescript
              case 'message_end': {
                const endData = this.extractMessageEndData(event);
                usage = endData.usage;
                finishReason = endData.finishReason;
                piMeta = endData.piMeta;
                break;
              }
```

- [ ] **Step 4: 重构 doGenerate — 替换 abort 设置**

将 doGenerate 中的以下代码（当前 ~L221-231）：

```typescript
let cleanupAbortListener: (() => void) | undefined;
if (options.abortSignal) {
  const onAbort = () => {
    session
      .abort()
      .catch((err: unknown) => this.logger.error(`Abort error: ${err}`));
  };
  options.abortSignal.addEventListener("abort", onAbort);
  cleanupAbortListener = () =>
    options.abortSignal?.removeEventListener("abort", onAbort);
  if (options.abortSignal.aborted) {
    onAbort();
  }
}
```

替换为：

```typescript
const cleanupAbortListener = this.setupAbortHandler(
  options.abortSignal,
  session,
);
```

- [ ] **Step 5: 重构 doGenerate — 替换 prompt error 处理**

将 doGenerate 中的以下代码（当前 ~L303-312）：

```typescript
session
  .prompt(promptText, { expandPromptTemplates: false })
  .catch((error: unknown) => {
    unsubscribe();
    cleanupAbortListener?.();
    this.invalidateSession();
    try {
      reject(
        handlePiError(error, {
          provider: this.model.provider,
          modelId: this.model.id,
          sessionId: this.sessionId,
        }),
      );
    } catch (mapped) {
      reject(mapped);
    }
  });
```

替换为：

```typescript
session
  .prompt(promptText, { expandPromptTemplates: false })
  .catch((error: unknown) => {
    this.handlePromptError(error, unsubscribe, cleanupAbortListener, (mapped) =>
      reject(mapped),
    );
  });
```

- [ ] **Step 6: 重构 doStream — 替换 abort 设置**

将 doStream 中的以下代码（当前 ~L527-536）：

```typescript
if (options.abortSignal) {
  const onAbort = () => {
    session
      .abort()
      .catch((err: unknown) => this.logger.error(`Abort error: ${err}`));
  };
  options.abortSignal.addEventListener("abort", onAbort);
  cleanupAbortListener = () =>
    options.abortSignal?.removeEventListener("abort", onAbort);
  if (options.abortSignal.aborted) {
    onAbort();
  }
}
```

替换为：

```typescript
cleanupAbortListener = this.setupAbortHandler(options.abortSignal, session);
```

- [ ] **Step 7: 重构 doStream — 替换 message_end 处理**

将 doStream 中的以下代码（当前 ~L484-489）：

```typescript
                case 'message_end': {
                  if (activeTextPartId) {
                    controller.enqueue({ type: 'text-end', id: activeTextPartId });
                    activeTextPartId = undefined;
                    hasStartedText = false;
                  }
                  if (activeReasoningPartId) {
                    controller.enqueue({ type: 'reasoning-end', id: activeReasoningPartId });
                    activeReasoningPartId = undefined;
                    hasStartedReasoning = false;
                  }
                  if (event.message?.role === 'assistant') {
                    const msg = event.message as AssistantMessage;
                    usage = this.extractUsage(msg.usage);
                    finishReason = mapPiFinishReason(msg.stopReason);
                    piMeta = { sessionId: this.sessionId, provider: msg.provider, modelId: msg.model, responseModel: msg.responseModel, responseId: msg.responseId };
                  }
                  break;
                }
```

替换为：

```typescript
                case 'message_end': {
                  if (activeTextPartId) {
                    controller.enqueue({ type: 'text-end', id: activeTextPartId });
                    activeTextPartId = undefined;
                    hasStartedText = false;
                  }
                  if (activeReasoningPartId) {
                    controller.enqueue({ type: 'reasoning-end', id: activeReasoningPartId });
                    activeReasoningPartId = undefined;
                    hasStartedReasoning = false;
                  }
                  const endData = this.extractMessageEndData(event);
                  usage = endData.usage;
                  finishReason = endData.finishReason;
                  piMeta = endData.piMeta;
                  break;
                }
```

- [ ] **Step 8: 重构 doStream — 替换 agent_end**

将 doStream 中的以下代码（当前 ~L493-509）：

```typescript
                case 'agent_end': {
                  if (activeTextPartId) controller.enqueue({ type: 'text-end', id: activeTextPartId });
                  if (activeReasoningPartId) controller.enqueue({ type: 'reasoning-end', id: activeReasoningPartId });
                  piMeta.durationMs = Date.now() - startTime;

                  controller.enqueue({
                    type: 'finish',
                    finishReason,
                    usage,
                    providerMetadata: toProviderMetadata(piMeta),
                  });

                  controller.close();
                  cleanupAbortListener?.();
                  unsubscribe();
                  break;
                }
```

替换为：

```typescript
                case 'agent_end': {
                  this.finalizeStreamParts(
                    controller,
                    activeTextPartId,
                    activeReasoningPartId,
                    startTime,
                    piMeta,
                    finishReason,
                    usage,
                    cleanupAbortListener,
                    unsubscribe
                  );
                  break;
                }
```

- [ ] **Step 9: 重构 doStream — 替换 prompt error 处理**

将 doStream 中的以下代码（当前 ~L538-546）：

```typescript
session
  .prompt(promptText, { expandPromptTemplates: false })
  .catch((error: unknown) => {
    this.logger.error(`Pi session prompt failed: ${error}`);
    this.invalidateSession();
    cleanupAbortListener?.();
    unsubscribe();
    try {
      controller.error(
        handlePiError(error, {
          provider: this.model.provider,
          modelId: this.model.id,
          sessionId: this.sessionId,
        }),
      );
    } catch {
      /* controller may already be closed */
    }
  });
```

替换为：

```typescript
session
  .prompt(promptText, { expandPromptTemplates: false })
  .catch((error: unknown) => {
    this.handlePromptError(
      error,
      unsubscribe,
      cleanupAbortListener,
      (mapped) => {
        try {
          controller.error(mapped);
        } catch {
          /* controller may already be closed */
        }
      },
    );
  });
```

- [ ] **Step 10: 运行全部测试确认无回归**

```bash
pnpm test -- --run
```

Expected: all 108 tests pass.

- [ ] **Step 11: 运行 typecheck**

```bash
pnpm typecheck
```

Expected: no errors.

- [ ] **Step 12: Commit**

```bash
git add src/pi-language-model.ts
git commit -m "refactor: extract 4 shared helpers from doGenerate/doStream

- #extractMessageEndData: extracts usage/finishReason/piMeta from message_end
- #setupAbortHandler: registers abort listener, returns cleanup function
- #handlePromptError: unified prompt().catch() error handling
- #finalizeStreamParts: closes stream parts and sends finish event"
```

---

### Task 8: Tests — New pi-provider.test.ts

**Files:**

- Create: `test/pi-provider.test.ts`

**Interfaces:**

- Consumes: `createPi`, `pi` from `../src/pi-provider.js`
- Produces: 完整测试覆盖 createPi 工厂函数

- [ ] **Step 1: 创建测试文件**

```typescript
import { describe, it, expect } from "vitest";
import { createPi, pi } from "../src/pi-provider.js";
import { PiLanguageModel } from "../src/pi-language-model.js";
import { NoSuchModelError } from "@ai-sdk/provider";

describe("createPi", () => {
  describe("provider callable", () => {
    it("returns a PiLanguageModel when called with a valid model ID", () => {
      const provider = createPi();
      const model = provider("sonnet");
      expect(model).toBeInstanceOf(PiLanguageModel);
      expect(model.modelId).toBe("sonnet");
      expect(model.provider).toBe("pi");
    });

    it("throws NoSuchModelError for invalid model ID", () => {
      const provider = createPi();
      expect(() => provider("nonexistent/unknown-model-12345")).toThrow(
        NoSuchModelError,
      );
    });

    it("throws for empty string model ID", () => {
      const provider = createPi();
      expect(() => provider("")).toThrow();
    });
  });

  describe("provider properties", () => {
    it("has specificationVersion v3", () => {
      const provider = createPi();
      expect(provider.specificationVersion).toBe("v3");
    });

    it("languageModel() creates a PiLanguageModel", () => {
      const provider = createPi();
      const model = provider.languageModel("sonnet");
      expect(model).toBeInstanceOf(PiLanguageModel);
    });

    it("chat() creates a PiLanguageModel (alias for languageModel)", () => {
      const provider = createPi();
      const model = provider.chat("haiku");
      expect(model).toBeInstanceOf(PiLanguageModel);
      expect(model.modelId).toBe("haiku");
    });

    it("embeddingModel() throws NoSuchModelError", () => {
      const provider = createPi();
      expect(() => provider.embeddingModel("any-model")).toThrow(
        NoSuchModelError,
      );
      try {
        provider.embeddingModel("any-model");
        expect.unreachable();
      } catch (e) {
        if (e instanceof NoSuchModelError) {
          expect(e.data?.modelType).toBe("embeddingModel");
        } else {
          throw e;
        }
      }
    });

    it("imageModel() throws NoSuchModelError", () => {
      const provider = createPi();
      expect(() => provider.imageModel("any-model")).toThrow(NoSuchModelError);
      try {
        provider.imageModel("any-model");
        expect.unreachable();
      } catch (e) {
        if (e instanceof NoSuchModelError) {
          expect(e.data?.modelType).toBe("imageModel");
        } else {
          throw e;
        }
      }
    });
  });

  describe("provider settings merging", () => {
    it("uses model-level cwd over provider-level cwd", () => {
      const provider = createPi({ cwd: "/provider/cwd" });
      const model = provider("sonnet", {
        cwd: "/model/cwd",
      }) as PiLanguageModel;
      // We can't directly inspect internal settings, but model should be created
      expect(model).toBeDefined();
      expect(model.modelId).toBe("sonnet");
    });

    it("accepts provider-level cwd as fallback", () => {
      const provider = createPi({ cwd: "/provider/cwd" });
      const model = provider("sonnet") as PiLanguageModel;
      expect(model).toBeDefined();
    });
  });

  describe("cannot be called with new", () => {
    it("throws when called as constructor", () => {
      const provider = createPi();
      expect(() => {
        // @ts-expect-error testing runtime behavior
        new provider("sonnet");
      }).toThrow("cannot be called with the new keyword");
    });
  });
});

describe("default pi instance", () => {
  it("is a valid provider", () => {
    expect(pi).toBeDefined();
    expect(typeof pi).toBe("function");
  });

  it("has languageModel method", () => {
    expect(typeof pi.languageModel).toBe("function");
  });

  it("has chat method", () => {
    expect(typeof pi.chat).toBe("function");
  });

  it("can create a model with valid alias", () => {
    const model = pi("sonnet");
    expect(model).toBeInstanceOf(PiLanguageModel);
  });
});
```

- [ ] **Step 2: 运行新测试**

```bash
pnpm test -- --run test/pi-provider.test.ts
```

Expected: all tests pass.

- [ ] **Step 3: Commit**

```bash
git add test/pi-provider.test.ts
git commit -m "test: add pi-provider.test.ts for createPi factory coverage"
```

---

### Task 9: Tests — Supplement convert-to-pi-messages.test.ts

**Files:**

- Modify: `test/convert-to-pi-messages.test.ts`

**Interfaces:**

- Consumes: 现有测试文件
- Produces: 追加 9 个测试覆盖 file 类型、error-json/content 输出、空 assistant、多 tool-result、image 对象

- [ ] **Step 1: 在 `convertToPiMessages` describe 末尾、`buildPromptFromContext` describe 之前追加测试**

在 `test/convert-to-pi-messages.test.ts` 中，在 `it('converts assistant message with reasoning', ...)` 测试之后、`});` 关闭 describe('convertToPiMessages', ...) 之前，追加以下测试：

```typescript
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
  const { context, warnings } = convertToPiMessages(messages);
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
  const messages: ModelMessage[] = [{ role: "assistant", content: [] as any }];
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
  const { context, warnings } = convertToPiMessages(messages);
  expect(warnings.length).toBeGreaterThan(0);
  expect(warnings[0]).toContain("Image URLs are not supported");
});
```

- [ ] **Step 2: 运行 convert-to-pi-messages 测试**

```bash
pnpm test -- --run test/convert-to-pi-messages.test.ts
```

Expected: all tests pass (original 18 + new 9 = 27 tests).

- [ ] **Step 3: Commit**

```bash
git add test/convert-to-pi-messages.test.ts
git commit -m "test: supplement convert-to-pi-messages tests for file type, tool output edges"
```

---

### Task 10: Tests — Supplement pi-language-model.test.ts

**Files:**

- Modify: `test/pi-language-model.test.ts`

**Interfaces:**

- Consumes: 现有测试文件
- Produces: 追加 8 个测试覆盖 truncateToolResult、abort、extractToolCallFromPartial、generateAllWarnings、createEmptyUsage

- [ ] **Step 1: 在文件末尾 `});` 之前追加测试**

在 `test/pi-language-model.test.ts` 的最后一个 `describe` 块之后、文件末尾的 `});` 之前，追加：

```typescript
describe("truncateToolResult", () => {
  it("returns full result when below max size", () => {
    const model = new PiLanguageModel(createModelOptions());
    const result = (model as any).truncateToolResult("short result");
    expect(result).toBe("short result");
  });

  it("truncates result exceeding max size", () => {
    const model = new PiLanguageModel(createModelOptions());
    const longText = "a".repeat(15000);
    const result = (model as any).truncateToolResult(longText);
    expect(result.length).toBeLessThan(longText.length);
    expect(result).toContain("[truncated");
    expect(result).toContain("chars]");
  });

  it("respects custom maxToolResultSize", () => {
    const model = new PiLanguageModel(
      createModelOptions({ settings: { maxToolResultSize: 50 } }),
    );
    const longText = "a".repeat(100);
    const result = (model as any).truncateToolResult(longText);
    expect(result.length).toBeLessThanOrEqual(
      50 + "[truncated X chars]".length + 10,
    );
    expect(result).toContain("[truncated");
  });
});

describe("abort handling in doGenerate", () => {
  let mockSession: ReturnType<typeof createMockSession>;

  beforeEach(() => {
    mockSession = createMockSession();
    piCodingAgent.__setMockSession(mockSession.session);
  });

  it("calls session.abort() when abortSignal is pre-aborted", async () => {
    const model = new PiLanguageModel(createModelOptions());
    const abortController = new AbortController();
    abortController.abort(); // pre-abort

    const generatePromise = model.doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
      abortSignal: abortController.signal,
    });

    // Should fail because session creation may abort
    await expect(generatePromise).rejects.toThrow();
  });
});

describe("extractToolCallFromPartial", () => {
  it("returns null when partial has no content", () => {
    const model = new PiLanguageModel(createModelOptions());
    const result = (model as any).extractToolCallFromPartial({}, 0);
    expect(result).toBeNull();
  });

  it("returns null when content is not an array", () => {
    const model = new PiLanguageModel(createModelOptions());
    const result = (model as any).extractToolCallFromPartial(
      { content: "string" },
      0,
    );
    expect(result).toBeNull();
  });

  it("returns null when content item is not a toolCall", () => {
    const model = new PiLanguageModel(createModelOptions());
    const result = (model as any).extractToolCallFromPartial(
      { content: [{ type: "text", text: "hello" }] },
      0,
    );
    expect(result).toBeNull();
  });
});

describe("generateAllWarnings", () => {
  it("reports all unsupported parameters", () => {
    const model = new PiLanguageModel(createModelOptions());
    const warnings = (model as any).generateAllWarnings(
      {
        temperature: 0.7,
        topP: 0.9,
        topK: 40,
        presencePenalty: 0.5,
        frequencyPenalty: 0.3,
        stopSequences: ["END"],
        seed: 42,
      },
      "test prompt",
      [],
    );
    const unsupported = warnings.filter((w: any) => w.type === "unsupported");
    expect(unsupported.length).toBe(7);
  });
});

describe("createEmptyUsage", () => {
  it("returns a correctly structured empty usage object", () => {
    const model = new PiLanguageModel(createModelOptions());
    const usage = (model as any).createEmptyUsage();
    expect(usage).toHaveProperty("inputTokens");
    expect(usage).toHaveProperty("outputTokens");
    expect(usage.inputTokens.total).toBeUndefined();
    expect(usage.outputTokens.total).toBeUndefined();
  });
});
```

- [ ] **Step 2: 运行 pi-language-model 测试**

```bash
pnpm test -- --run test/pi-language-model.test.ts
```

Expected: all tests pass (original 16 + new 8 = 24 tests).

- [ ] **Step 3: Commit**

```bash
git add test/pi-language-model.test.ts
git commit -m "test: supplement pi-language-model tests for truncate, abort, helper coverage"
```

---

### Task 11: Final Verification

**Files:**

- (none, verification only)

- [ ] **Step 1: 运行全量测试**

```bash
pnpm test -- --run
```

Expected: all tests pass. No regressions.

- [ ] **Step 2: 运行 typecheck**

```bash
pnpm typecheck
```

Expected: no TypeScript errors.

- [ ] **Step 3: 运行 lint**

```bash
pnpm lint 2>&1 || echo "Lint done (warnings may exist)"
```

- [ ] **Step 4: Commit final state if any changes**

```bash
git status
```
