---
date: 2026-06-12T16:47:04+0800
author: haoyiqiang
commit: b9f139b
branch: master
repository: ai-sdk-provider-pi
topic: "Pi AI SDK Provider Bug Fixes & Test Suite"
tags: [pi-coding-agent, vercel-ai-sdk, language-model-v3, provider, testing]
status: complete
last_updated: 2026-06-12T16:47:04+0800
last_updated_by: haoyiqiang
type: feature_development
---

# Handoff: ai-sdk-provider-pi Bug Fixes & Test Suite

## Task(s)

1. **Resume from previous handoff** — ✅ 完成
   - 读取并验证了 `.rpiv/artifacts/handoffs/2026-06-12_13-43-57_pi-ai-sdk-provider-implementation.md`
   - 确认所有原始任务（项目骨架、核心模块、构建验证）均已完成

2. **修复 ThinkingLevel 类型不匹配** — ✅ 完成
   - `types.ts` 从 `pi-ai` 导入 `ThinkingLevel`（不含 `"off"`），但 `CreateAgentSessionOptions.thinkingLevel` 接受含 `"off"` 的版本
   - 改用 `ModelThinkingLevel`（= `"off" | ThinkingLevel`），与 Pi SDK 实际 API 一致

3. **修复 session.dispose() 资源泄漏** — ✅ 完成
   - 添加 `dispose()` 公共方法
   - 修复 `doGenerate` 和 `doStream` 中 `AbortSignal` 监听器在所有退出路径的清理
   - `ensureSession()` 支持 dispose 后自动重建

4. **修复 mapPiFinishReason 缺失映射** — ✅ 完成
   - Pi 的 `StopReason` 包含 `"toolUse"` (camelCase)，但映射函数只处理了 `"tool_use"` (snake_case)

5. **编写完整测试套件** — ✅ 完成
   - 104 个测试全部通过，覆盖 5 个测试文件

## Critical References

1. `/Volumes/VM/Agent/ai-sdk-provider-claude-code/src/claude-code-language-model.ts` — 最佳参考蓝本，2662行完整 LanguageModelV3 实现
2. `.rpiv/artifacts/handoffs/2026-06-12_13-43-57_pi-ai-sdk-provider-implementation.md` — 原始交接文档，包含完整的 Pi SDK API 分析和学习笔记

## Recent changes

- `src/types.ts:1` — 将 `ThinkingLevel as PiThinkingLevel` 改为 `ModelThinkingLevel as PiThinkingLevel`，使类型包含 `"off"` 选项
- `src/map-pi-finish-reason.ts:41-42` — 添加 `case 'toolUse': return { unified: 'tool-calls', raw };` 映射
- `src/pi-language-model.ts:46` — 添加 `private disposed = false;` 字段
- `src/pi-language-model.ts:60-76` — 添加 `dispose()` 公共方法，调用 `session.dispose()` 并清理状态
- `src/pi-language-model.ts:77-82` — `ensureSession()` 支持 disposed 状态后自动重建
- `src/pi-language-model.ts:115-125` — `doGenerate` 中重写 abort listener 为可清理模式（`cleanupAbortListener`）
- `src/pi-language-model.ts:162-167` — `doGenerate` 的 agent_end 和 error 路径添加 `cleanupAbortListener?.()`
- `src/pi-language-model.ts:315` — `doStream` 中提升 `cleanupAbortListener` 声明到 stream 外层作用域
- `src/pi-language-model.ts:317` — 移除 subscribe 内部的重复声明
- `src/pi-language-model.ts:462-463` — agent_end 路径添加 `cleanupAbortListener?.()`
- `src/pi-language-model.ts:484-486` — error 路径添加 `cleanupAbortListener?.()`
- `src/pi-language-model.ts:497-498` — prompt catch 路径添加 `cleanupAbortListener?.()`
- `src/pi-language-model.ts:505-506` — cancel 回调添加 `cleanupAbortListener?.()`
- `test/map-pi-finish-reason.test.ts:1-79` — 新建：21 个测试
- `test/validation.test.ts:1-147` — 新建：28 个测试
- `test/convert-to-pi-messages.test.ts:1-190` — 新建：18 个测试
- `test/errors.test.ts:1-199` — 新建：25 个测试
- `test/pi-language-model.test.ts:1-490` — 新建：12 个测试
- `vitest.config.ts` — 新建：vitest 配置

## Learnings

### 1. Pi SDK ThinkingLevel 类型系统三层结构

Pi SDK 有三个相关但不同的类型：
- `pi-ai.ThinkingLevel` = `"minimal" | "low" | "medium" | "high" | "xhigh"` (不含 "off")
- `pi-ai.ModelThinkingLevel` = `"off" | ThinkingLevel` (含 "off")
- `pi-agent-core.ThinkingLevel` = `"off" | "minimal" | "low" | "medium" | "high" | "xhigh"` (含 "off")

`CreateAgentSessionOptions.thinkingLevel` 使用 `pi-agent-core` 版本（含 "off"），所以 provider 必须使用 `ModelThinkingLevel` 而非 `ThinkingLevel`。

### 2. Pi 的 StopReason 是 camelCase

Pi 的 `StopReason` 类型值是 camelCase（如 `"toolUse"`, `"end_turn"`），但原始 provider API 的 stop reasons 是 snake_case（如 `"tool_use"`）。映射函数必须同时处理两种格式，因为 Pi SDK 会规范化大部分值，但某些原始 provider 值可能泄漏。

### 3. ReadableStream cancel 回调无法访问 start() 中的局部变量

`doStream` 中 `cancel()` 回调是 `ReadableStream` 构造器的独立方法，无法访问 `start()` 回调中的 `let` 变量。解决方案是将 `cleanupAbortListener` 提升到 `doStream` 方法级别。

### 4. Pi SDK `ImageContent` 类型与文档不一致

SDK 文档显示嵌套的 `source` 对象，但实际类型是平面的 `{ type: "image", data: string, mimeType: string }`。代码中已使用正确的平面结构。

### 5. vitest 模块级 mock 的调用计数不会自动重置

`vi.mock('@earendil-works/pi-coding-agent')` 创建的 spy 在 `beforeEach` 间不会重置调用计数。验证 session 复用时，应检查 `session.subscribe` 的调用次数而非 `createAgentSession` 的调用次数。

## Artifacts

- `test/map-pi-finish-reason.test.ts` — StopReason 映射测试
- `test/validation.test.ts` — 模型 ID 解析和设置校验测试
- `test/convert-to-pi-messages.test.ts` — 消息格式转换测试
- `test/errors.test.ts` — 错误处理逻辑测试
- `test/pi-language-model.test.ts` — PiLanguageModel 核心逻辑测试（含 mock Pi SDK）
- `vitest.config.ts` — vitest 配置文件

## Action Items & Next Steps

1. **集成测试（真实 Pi SDK）**
   - 使用真实 Pi SDK 进行端到端测试
   - 测试 `streamText()` + `pi('anthropic/claude-sonnet-4')` 的完整流程
   - 测试 `generateText()` 的非流式模式
   - 测试工具执行（read、bash、edit）的流式回传
   - 测试 thinking/reasoning 的流式输出

2. **Session 复用和生命周期管理优化**
   - 当前实现中 session 在 `ensureSession()` 中创建但不自动 dispose
   - 需要添加更完善的 session 生命周期管理
   - 考虑 API Route 场景下的 session 复用策略
   - 考虑添加 `[Symbol.dispose]` 支持（需更新 tsconfig libs）

3. **conversation history 传递优化**
   - 当前 `buildPromptFromContext()` 只取最后一条用户消息
   - Pi session 自身管理对话历史，但首次 prompt 需要正确传入历史消息
   - 可能需要通过 Pi 的 `SessionManager` 或 `session.sendCustomMessage()` 传递历史

4. **Next.js API Route 示例**
   - 创建完整的 Next.js 示例项目
   - 包含 API Route + ai-elements 前端

5. **Pi 特有功能支持**
   - AbortSignal 桥接 — AI SDK 的 AbortSignal → session.abort()（框架已就绪，需端到端验证）
   - `session.steer()` — 支持中途注入指令
   - 流式输入模式 — Pi 的 `streamingBehavior` 参数

6. **暴露 responseModel/responseId 到 providerMetadata**
   - Pi 的 `AssistantMessage` 包含 `responseModel` 和 `responseId` 字段
   - 可在 `message_end` 事件中将其放入 `piMeta` 以便上层消费

## Other Notes

### 已安装依赖版本
- `@ai-sdk/provider`: 3.0.10
- `@earendil-works/pi-coding-agent`: 0.79.1
- `@earendil-works/pi-ai`: 0.79.1
- `ai`: 6.0.201 (devDep)
- `vitest`: 3.2.4

### 参考项目位置
- `ai-sdk-provider-claude-code` 在 `/Volumes/VM/Agent/ai-sdk-provider-claude-code/`

### Pi SDK 文档路径
- SDK 文档：`/Users/haoyiqiang/.nvm/versions/node/v24.1.0/lib/node_modules/@earendil-works/pi-coding-agent/docs/sdk.md`
- Custom Provider 文档：`/Users/haoyiqiang/.nvm/versions/node/v24.1.0/lib/node_modules/@earendil-works/pi-coding-agent/docs/custom-provider.md`

### Pi SDK 关键类型导入路径
- `AgentSessionEvent` / `createAgentSession` / `SessionManager` / `AuthStorage` / `ModelRegistry` → `@earendil-works/pi-coding-agent`
- `Model` / `Api` / `AssistantMessage` / `Usage` / `Context` / `ModelThinkingLevel` → `@earendil-works/pi-ai`

### 社区参考项目
- edge-pi：`https://github.com/marcusschiesser/edge-pi` — 用 AI SDK 重写 Pi
- bunny-agent：`https://github.com/buda-ai/bunny-agent` — Pi runner + AI SDK UI native stream
