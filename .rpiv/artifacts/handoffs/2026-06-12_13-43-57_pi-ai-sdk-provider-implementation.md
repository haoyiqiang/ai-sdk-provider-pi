---
date: 2026-06-12T13:43:57+0800
author: haoyiqiang
commit: b9f139b
branch: master
repository: ai-sdk-provider-pi
topic: "Pi + AI SDK Provider Implementation"
tags: [pi-coding-agent, vercel-ai-sdk, language-model-v3, provider, integration]
status: complete
last_updated: 2026-06-12T13:43:57+0800
last_updated_by: haoyiqiang
type: feature_development
---

# Handoff: ai-sdk-provider-pi 初始实现完成

## Task(s)

1. **研究 Pi + AI SDK 集成方式** — ✅ 完成（上一 session）
   - 确认 `ai-sdk-provider-claude-code` 为最佳参考蓝本
   - 完成 Pi SDK API 深度分析

2. **创建 `ai-sdk-provider-pi` 项目骨架** — ✅ 完成
   - package.json、tsconfig.json、tsup.config.ts

3. **实现核心模块** — ✅ 完成
   - PiLanguageModel（doStream/doGenerate）
   - PiProvider 工厂（createPi/pi）
   - 消息转换（convertToPiMessages）
   - Finish Reason 映射
   - 错误处理
   - 校验模块
   - 类型定义
   - 入口文件

4. **构建验证** — ✅ 完成
   - TypeScript 类型检查通过
   - tsup 构建成功（ESM + CJS + DTS）
   - Git 提交完成

## Critical References

1. `/Volumes/VM/Agent/ai-sdk-provider-claude-code/src/claude-code-language-model.ts` — 最佳参考蓝本，2662行完整 LanguageModelV3 实现
2. `/Volumes/VM/Agent/ai-sdk-provider-claude-code/src/claude-code-provider.ts` — Provider 工厂模式参考

## Recent changes

所有文件均为新建：

- `src/pi-language-model.ts:1-553` — 核心 PiLanguageModel 类，实现 doStream() 和 doGenerate()
- `src/pi-provider.ts:1-223` — createPi()/pi() 工厂函数，模型 ID 解析
- `src/convert-to-pi-messages.ts:1-334` — AI SDK ModelMessage[] → Pi Context 转换
- `src/map-pi-finish-reason.ts:1-73` — Pi stopReason → AI SDK FinishReason 映射
- `src/errors.ts:1-299` — 错误处理（Pi SDK → AI SDK ProviderError）
- `src/validation.ts:1-127` — 模型 ID 解析和配置校验
- `src/types.ts:1-219` — 类型定义
- `src/index.ts:1-91` — 入口文件
- `package.json` — 项目配置
- `tsconfig.json` / `tsup.config.ts` — 构建配置
- `README.md` — 使用文档

## Learnings

### 1. AI SDK v6 类型系统与 v5 有重大差异

这是实现过程中最大的挑战，需要特别注意：

- **`LanguageModelV3Usage`** 是嵌套对象，不是平面数字：
  ```typescript
  // v6 正确格式
  { inputTokens: { total: number, noCache: number, cacheRead: number, cacheWrite: number },
    outputTokens: { total: number, text: number, reasoning: number } }
  // 而非 v5 的平面格式
  { inputTokens: number, outputTokens: number, totalTokens: number }
  ```

- **`LanguageModelV3ToolCall`** 用 `input` (string) 而非 `args`
- **`LanguageModelV3ToolResult`** 没有 `providerExecuted` 属性，字段是 `result: NonNullable<JSONValue>` 而非 `output`
- **`SharedV3ProviderMetadata`** = `Record<string, JSONObject>`，不允许 null 值
- **Stream 中用 `stream-start` 替代 `warning`** 事件发送警告
- **`FilePart`** 用 `mediaType` 而非 `mimeType`，`data` 是 `DataContent | URL`
- **`ToolCallPart`** 用 `input` 而非 `args`
- **`ToolResultPart`** 用 `output: ToolResultOutput` 而非 `result`

### 2. Pi SDK Usage 类型字段名与直觉不同

Pi 的 `Usage` 接口用的是 `input`/`output`/`cacheRead`/`cacheWrite`/`totalTokens`，而不是 `inputTokens`/`outputTokens`：
```typescript
interface Usage {
  input: number;      // 不是 inputTokens
  output: number;     // 不是 outputTokens
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}
```

### 3. Pi SDK `session.prompt()` 行为

- `session.prompt()` 实际上**等待完成才 resolve**（交接文档说"不等待完成"有误）
- 但 `agent_end` 事件仍必须用于关闭 ReadableStream 的 controller
- `session.dispose()` 必须在 finally 中调用以清理资源
- 流式发送中途消息需指定 `streamingBehavior: 'steer' | 'followUp'`

### 4. 回调 → ReadableStream 桥接模式

核心模式是在 `ReadableStream` 的 `start()` 回调中订阅 Pi 事件：
```typescript
const stream = new ReadableStream<LanguageModelV3StreamPart>({
  start: (controller) => {
    const unsubscribe = session.subscribe((event) => {
      // Pi 事件 → controller.enqueue(AI SDK stream part)
      if (event.type === 'agent_end') {
        controller.close();
        unsubscribe();
      }
    });
    session.prompt(promptText, { expandPromptTemplates: false });
  },
  cancel: () => { session.abort(); },
});
```

### 5. Pi 事件到 AI SDK Stream Part 的完整映射

| Pi 事件 | AI SDK Stream Part |
|---------|-------------------|
| `message_update` + `text_start/delta/end` | `text-start/delta/end` |
| `message_update` + `thinking_start/delta/end` | `reasoning-start/delta/end` |
| `message_update` + `toolcall_start/delta/end` | `tool-input-start/delta` + `tool-call` |
| `tool_execution_start` | `tool-input-start` (如果未通过 toolcall_start 发出) |
| `tool_execution_end` | `tool-result` |
| `message_end` | 提取 usage 和 finishReason |
| `agent_end` | `finish` + `controller.close()` |

### 6. Pi SDK 包版本

`@earendil-works/pi-coding-agent` 和 `@earendil-works/pi-ai` 的最新版本是 `0.79.1`，不是 `0.1.0`。

## Artifacts

- `/Volumes/VM/Agent/ai-sdk-provider-pi/` — 完整项目
- `/Volumes/VM/Agent/ai-sdk-provider-pi/src/pi-language-model.ts` — 核心实现
- `/Volumes/VM/Agent/ai-sdk-provider-pi/src/pi-provider.ts` — Provider 工厂
- `/Volumes/VM/Agent/ai-sdk-provider-pi/src/convert-to-pi-messages.ts` — 消息转换
- `/Volumes/VM/Agent/ai-sdk-provider-pi/README.md` — 使用文档

## Action Items & Next Steps

1. **编写单元测试**
   - 测试 `convertToPiMessages()` 的各种消息格式转换
   - 测试 `mapPiFinishReason()` 的各种 stopReason 映射
   - 测试 `parseModelId()` 的 ID 解析和别名
   - 测试 `PiLanguageModel` 的 doStream/doGenerate（需要 mock Pi SDK）
   - 测试错误处理逻辑

2. **集成测试**
   - 使用真实 Pi SDK 进行端到端测试
   - 测试 `streamText()` + `pi('anthropic/claude-sonnet-4')` 的完整流程
   - 测试 `generateText()` 的非流式模式
   - 测试工具执行（read、bash、edit）的流式回传
   - 测试 thinking/reasoning 的流式输出

3. **Session 复用和生命周期管理**
   - 当前实现中 session 在 `ensureSession()` 中创建但不自动 dispose
   - 需要添加更完善的 session 生命周期管理
   - 考虑 API Route 场景下的 session 复用策略

4. **conversation history 传递优化**
   - 当前 `buildPromptFromContext()` 只取最后一条用户消息
   - Pi session 自身管理对话历史，但首次 prompt 需要正确传入历史消息
   - 可能需要通过 Pi 的 `SessionManager` 或 `session.sendCustomMessage()` 传递历史

5. **Next.js API Route 示例**
   - 创建完整的 Next.js 示例项目
   - 包含 API Route + ai-elements 前端

6. **处理 Pi 特有挑战**（来自交接文档）
   - AbortSignal 桥接 — AI SDK 的 AbortSignal → session.abort()
   - `session.steer()` — 支持中途注入指令
   - 流式输入模式 — Pi 的 `streamingBehavior` 参数

## Other Notes

### 参考项目位置
- `ai-sdk-provider-claude-code` 在 `/Volumes/VM/Agent/ai-sdk-provider-claude-code/`
- 原交接文档中的路径 `/Volumes/VM/Chrome/ai-sdk-provider-claude-code/` 已过时

### Pi SDK 文档路径
- SDK 文档：`/Users/haoyiqiang/.nvm/versions/node/v24.1.0/lib/node_modules/@earendil-works/pi-coding-agent/docs/sdk.md`
- Custom Provider 文档：`/Users/haoyiqiang/.nvm/versions/node/v24.1.0/lib/node_modules/@earendil-works/pi-coding-agent/docs/custom-provider.md`

### Pi SDK 关键类型导入路径
- `AgentSessionEvent` / `createAgentSession` / `SessionManager` / `AuthStorage` / `ModelRegistry` → `@earendil-works/pi-coding-agent`
- `Model` / `Api` / `AssistantMessage` / `Usage` / `Context` → `@earendil-works/pi-ai`
- `getModel` / `stream` / `complete` → `@earendil-works/pi-ai`

### 社区参考项目
- edge-pi：`https://github.com/marcusschiesser/edge-pi` — 用 AI SDK 重写 Pi
- bunny-agent：`https://github.com/buda-ai/bunny-agent` — Pi runner + AI SDK UI native stream
