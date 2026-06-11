---
date: 2026-06-11T16:08:55+0800
author: haoyiqiang
commit: 4da7070
branch: master
repository: Chrome
topic: "Pi + Vercel AI SDK Integration Research"
tags: [pi-coding-agent, vercel-ai-sdk, ai-elements, provider, integration]
status: complete
last_updated: 2026-06-11T16:08:55+0800
last_updated_by: haoyiqiang
type: research
---

# Handoff: Pi Coding Agent + Vercel AI SDK (ai-elements) 集成方案研究

## Task(s)

1. **研究 Pi Coding Agent 与 Vercel AI SDK 的结合方式** — ✅ 完成
   - 用户希望使用 ai-elements 作为前端 UI，使用 Pi 作为后端 AI 引擎
   - 搜索了社区开源方案、官方文档、API 细节
   - 评估了多种集成架构

2. **寻找社区已有实现** — ✅ 完成
   - 发现了 3 个相关项目并分析其适用性
   - Clone 了 `ai-sdk-provider-claude-code` 项目并深入阅读全部核心源码
   - 确认这是最佳参考蓝本

3. **深度分析 `ai-sdk-provider-claude-code` 的实现模式** — ✅ 完成
   - 阅读了全部核心源码（provider、language-model、message-conversion、types 等）
   - 提炼出可直接借鉴的架构模式和关键差异

## Critical References

1. `/Volumes/VM/Chrome/ai-sdk-provider-claude-code/src/claude-code-language-model.ts` — 最佳参考蓝本，LanguageModelV3 完整实现
2. `/Volumes/VM/Chrome/ai-sdk-provider-claude-code/src/claude-code-provider.ts` — Provider 工厂函数模式
3. `/Volumes/VM/Chrome/ai-sdk-provider-claude-code/src/convert-to-claude-code-messages.ts` — 消息格式转换模式

## Recent changes

无代码变更。本次为纯研究 session，仅 clone 了参考项目到 `/Volumes/VM/Chrome/ai-sdk-provider-claude-code/`。

## Learnings

### 1. 最佳集成架构：Pi → AI SDK Custom Provider（LanguageModelV3）

将 Pi SDK 封装为 AI SDK 的 `LanguageModelV3` provider，这样：
- 前端 `useChat()` + `streamText()` + ai-elements 组件开箱即用
- Pi 的工具能力（read、bash、edit、write）通过 Pi SDK 完整保留
- Pi 支持 15+ LLM provider，一个集成即访问所有模型

### 2. `ai-sdk-provider-claude-code` 可几乎 1:1 移植

该项目将 `@anthropic-ai/claude-agent-sdk` 封装为 AI SDK LanguageModelV3，与 Pi 的场景完全同构。核心架构可直接复用：

- **Provider 工厂**：`createClaudeCode()` → `createPi()`
- **LanguageModelV3 实现**：`ClaudeCodeLanguageModel` → `PiLanguageModel`
- **消息转换**：`convertToClaudeCodeMessages()` → `convertToPiMessages()`
- **Finish Reason 映射**：`mapClaudeCodeFinishReason()` → `mapPiFinishReason()`

### 3. 核心技术挑战：回调 → ReadableStream 桥接

Pi 的 `session.subscribe()` 是回调式，而 AI SDK 的 `doStream()` 需要返回 `ReadableStream<LanguageModelV3StreamPart>`。解决方案：

```typescript
// 在 ReadableStream 的 start() 中订阅 Pi 事件
const stream = new ReadableStream({
  start: (controller) => {
    session.subscribe((event) => {
      // Pi 事件 → AI SDK stream parts
    });
    session.prompt(userMessage); // 触发执行
  }
});
```

### 4. Pi 事件到 AI SDK Stream Part 的映射关系

| Pi 事件 | AI SDK Stream Part |
|---------|-------------------|
| `message_update` + `text_delta` | `{ type: 'text-delta', id, delta }` |
| `message_update` + `thinking_delta` | `{ type: 'reasoning-delta', id, delta }` |
| `tool_execution_start` | `{ type: 'tool-input-start', id, toolName }` |
| `tool_execution_end` | `{ type: 'tool-result', toolCallId, toolName, result }` |
| `agent_end` | `{ type: 'finish', finishReason, usage }` |
| `message_update` + `error` | `{ type: 'error', error }` |

### 5. 关键差异（Pi vs Claude Code Provider）

| 方面 | Claude Code Provider | Pi Provider |
|------|---------------------|-------------|
| 底层 SDK | `@anthropic-ai/claude-agent-sdk` 的 `query()` | `@earendil-works/pi-coding-agent` 的 `createAgentSession()` |
| 调用方式 | `query()` 返回 AsyncIterable | `session.prompt()` + `session.subscribe()` 回调式 |
| 模型选择 | `opus`/`sonnet`/`haiku` | `(provider, modelId)` 元组如 `anthropic/claude-sonnet-4` |
| Session | CLI session_id | Pi `SessionManager.inMemory()` / `.create()` |
| 工具系统 | CLI 内置工具 | Pi 的 `createCodingTools()` |
| 流式输入 | `toAsyncIterablePrompt()` 支持 mid-session 注入 | Pi 的 `session.steer()` / `session.followUp()` |

### 6. 社区已有项目评估

| 项目 | 方式 | 匹配度 |
|------|------|--------|
| **ai-sdk-provider-claude-code** | Claude Agent SDK → AI SDK LanguageModelV3 | ⭐⭐⭐⭐⭐ 最佳参考，架构同构 |
| **edge-pi** (marcusschiesser/edge-pi) | 用 AI SDK 重写 Pi 核心逻辑 | ⭐⭐⭐ 思路不同，是从零重建而非封装 Pi SDK |
| **bunny-agent** (buda-ai/bunny-agent) | Pi runner + AI SDK UI native stream | ⭐⭐⭐⭐ 已证明 Pi→AI SDK stream 直通可行，但偏 SaaS 平台 |

### 7. Pi SDK 关键 API

- `createAgentSession()` — 创建会话
- `session.prompt(text)` — 发送消息（不等待完成！完成通过 `agent_end` 事件通知）
- `session.subscribe((event) => {...})` — 订阅流式事件
- `session.steer(text)` — 中途注入指令
- `session.abort()` — 中断
- `session.dispose()` — 清理资源（必须在 finally 中调用）
- `SessionManager.inMemory()` — 内存 session（无需文件持久化）
- `AuthStorage` / `ModelRegistry` — 认证和模型管理
- `getModel(provider, modelId)` — 获取模型实例

## Artifacts

- `/Volumes/VM/Chrome/ai-sdk-provider-claude-code/` — clone 的参考项目（完整源码）

## Action Items & Next Steps

1. **创建 `ai-sdk-provider-pi` 项目骨架**
   - 参照 `ai-sdk-provider-claude-code` 的 `package.json` / `tsup.config.ts` / `tsconfig.json` 搭建
   - 依赖：`@earendil-works/pi-coding-agent`、`@earendil-works/pi-ai`、`@ai-sdk/provider`、`@ai-sdk/provider-utils`、`ai` (peerDep)

2. **实现 `PiLanguageModel`**（核心，最大工作量）
   - `doStream()` — Pi subscribe 回调 → `ReadableStream<LanguageModelV3StreamPart>` 桥接
   - `doGenerate()` — 非流式版本，收集完整结果后返回
   - 参考 `claude-code-language-model.ts` 的完整结构（2662行）

3. **实现消息格式转换** `convert-to-pi-messages.ts`
   - AI SDK `ModelMessage[]` → Pi 的 `Context` 对象
   - 参考 `convert-to-claude-code-messages.ts`

4. **实现 Provider 工厂** `pi-provider.ts`
   - `createPi()` / `pi()` — 模型 ID 格式：`"anthropic/claude-sonnet-4"` 或简写 `"sonnet"`
   - 参考 `claude-code-provider.ts`

5. **实现辅助模块**
   - `map-pi-finish-reason.ts` — Pi stopReason → AI SDK FinishReason
   - `validation.ts` — 模型/配置校验
   - `errors.ts` — 错误分类（认证、超时、溢出等）
   - `logger.ts` — 日志

6. **接入 ai-elements 前端**
   - 安装 `pnpm dlx ai-elements@latest`
   - Next.js API Route 使用 `streamText({ model: pi('anthropic/claude-sonnet-4'), messages })`
   - 前端 `useChat()` + ai-elements 的 Conversation/Message/PromptInput 组件

7. **处理 Pi 特有挑战**
   - `session.prompt()` 不等待完成 — 必须在 `agent_end` 事件后才 `controller.close()`
   - Session 复用 — 建议在 API Route 中复用 Pi session
   - AbortSignal 桥接 — AI SDK 的 `AbortSignal` → `session.abort()`
   - `session.dispose()` 必须在 finally 中调用

## Other Notes

### Pi SDK 文档路径
- SDK 文档：`/Users/haoyiqiang/.nvm/versions/node/v24.1.0/lib/node_modules/@earendil-works/pi-coding-agent/docs/sdk.md`
- Custom Provider 文档：`/Users/haoyiqiang/.nvm/versions/node/v24.1.0/lib/node_modules/@earendil-works/pi-coding-agent/docs/custom-provider.md`

### 参考项目关键文件
- Provider 工厂：`/Volumes/VM/Chrome/ai-sdk-provider-claude-code/src/claude-code-provider.ts`
- LanguageModelV3 实现：`/Volumes/VM/Chrome/ai-sdk-provider-claude-code/src/claude-code-language-model.ts`（2662行，核心）
- 消息转换：`/Volumes/VM/Chrome/ai-sdk-provider-claude-code/src/convert-to-claude-code-messages.ts`
- 类型定义：`/Volumes/VM/Chrome/ai-sdk-provider-claude-code/src/types.ts`
- Finish Reason 映射：`/Volumes/VM/Chrome/ai-sdk-provider-claude-code/src/map-claude-code-finish-reason.ts`

### 其他参考项目
- edge-pi：`https://github.com/marcusschiesser/edge-pi` — 用 AI SDK 重写 Pi，支持 Webcontainers/Vercel Sandboxes
- bunny-agent：`https://github.com/buda-ai/bunny-agent` — Pi runner + AI SDK UI native stream，SaaS 平台化
- Archon Pi 集成 Issue：`https://github.com/coleam00/Archon/issues/965` — Pi 作为 provider 的详细实现任务清单

### AI SDK 文档
- Transport 文档：`https://ai-sdk.dev/docs/ai-sdk-ui/transport`
- Custom Provider 文档：`https://ai-sdk.dev/providers/community-providers/custom-providers`
- AI Elements 教程：`https://vercel.com/academy/ai-sdk/ai-elements`
