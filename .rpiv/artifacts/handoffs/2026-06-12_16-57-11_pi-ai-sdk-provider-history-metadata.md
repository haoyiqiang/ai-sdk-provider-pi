---
date: 2026-06-12T17:03:00+0800
author: haoyiqiang
commit: 61b8444
branch: master
repository: ai-sdk-provider-pi
topic: "会话历史传递、ProviderMetadata 扩展、错误恢复与集成测试"
tags: [pi-coding-agent, vercel-ai-sdk, language-model-v3, provider, testing, error-handling, session-lifecycle]
status: in_progress
last_updated: 2026-06-12T17:03:00+0800
last_updated_by: haoyiqiang
type: feature_development
---

# Handoff: ai-sdk-provider-pi 会话历史传递、ProviderMetadata 扩展、错误恢复与集成测试

## Task(s)

1. **从交接文档恢复** — ✅ 完成
   - 读取并验证了 `.rpiv/artifacts/handoffs/2026-06-12_16-47-04_pi-ai-sdk-provider-bugfix-tests.md`
   - 验证了 104 个测试全部通过，构建成功
   - 提交了之前未提交的更改（bug 修复 + 测试）

2. **系统提示词（system prompt）传递给 Pi session** — ✅ 完成
   - `convertToPiMessages()` 已经从 AI SDK 消息中提取了 `context.systemPrompt`
   - 在 `doGenerate` 和 `doStream` 中，通过 `session.agent.state.systemPrompt = context.systemPrompt` 传递给 Pi session
   - 添加了 2 个测试验证系统提示词正确传递

3. **暴露 responseModel/responseId 到 providerMetadata** — ✅ 完成
   - 在 `PiProviderMetadata` 接口中添加了 `responseModel` 和 `responseId` 字段
   - 在 `message_end` 事件中从 `AssistantMessage` 提取并存入 `piMeta`
   - 由于 `toProviderMetadata()` 将原始值包装为 `{ value: string }` 对象，测试中使用 `toEqual` 验证包装后的值
   - 添加了 2 个测试验证（doGenerate + doStream）

4. **集成测试（真实 Pi SDK）** — ✅ 完成
   - 创建了 `test/pi-language-model.integration.test.ts` 测试文件
   - 包含 10 个端到端测试：doGenerate、doStream、AbortSignal、session 复用、错误处理、model 别名、系统提示词、dispose()
   - 默认跳过（通过 `PI_INTEGRATION_TEST=true` 环境变量启用）
   - 需要配置 API key 才能运行（使用 `anthropic/claude-sonnet-4` 或 `openai/gpt-4o`）

5. **Session 自动错误恢复** — ✅ 完成
   - 添加了 `invalidateSession()` 私有方法
   - 在 `doGenerate` 和 `doStream` 的 `session.prompt()` 错误路径中调用
   - 在外部 try/catch 中也调用（如 `ensureSession()` 失败）
   - 添加了测试验证：prompt 失败后自动创建新 session

6. **关键 Bug 修复：handlePiError 传播问题** — ✅ 完成
   - **问题**：`handlePiError()` 的返回类型为 `never`（总是 throw），所以 `reject(handlePiError(...))` 中的 `reject()` 永远不会被执行
   - **影响**：`doGenerate` 中 Promise 永远不会 settle，`doStream` 中 `controller.error()` 不会被调用
   - **修复**：将所有 `reject(handlePiError(...))` 和 `controller.error(handlePiError(...))` 包装在 try/catch 中
   - 同样修复了 `doStream` subscribe 回调中的 `controller.error(handlePiError(...))` 和 prompt.catch 中的错误处理
   - 这个 bug 之前没有被单元测试发现（mock 测试没有触发 doGenerate/doStream 内部的错误路径）

## Critical References

1. `/Volumes/VM/Agent/ai-sdk-provider-pi/src/pi-language-model.ts` — 主实现文件
2. `/Volumes/VM/Agent/ai-sdk-provider-pi/src/types.ts` — 类型定义
3. `/Volumes/VM/Agent/ai-sdk-provider-pi/src/errors.ts` — 错误处理（包含 `handlePiError`）
4. `/Users/haoyiqiang/.nvm/versions/node/v24.1.0/lib/node_modules/@earendil-works/pi-coding-agent/docs/sdk.md` — Pi SDK 文档
5. `node_modules/@earendil-works/pi-ai/dist/types.d.ts` — Pi AI 类型定义（AssistantMessage, StopReason 等）

## Recent changes

- `src/types.ts` — 在 `PiProviderMetadata` 中添加 `responseModel` 和 `responseId` 字段
- `src/pi-language-model.ts` — 多个重要变更（见下面详细变更）
- `test/pi-language-model.test.ts` — 添加 4 个新测试（系统提示词、responseModel/responseId、doStream 系统提示词、session 失效恢复）
- `test/pi-language-model.integration.test.ts` — 新建：10 个集成测试（默认跳过）

### `src/pi-language-model.ts` 详细变更

1. 添加 `private invalidateSession()` 方法（行 ~140）：清理 session 引用但不调用 `session.dispose()`
2. `doGenerate` 中：创建 session 后设置 `session.agent.state.systemPrompt`
3. `doStream` 中：创建 session 后设置 `session.agent.state.systemPrompt`
4. 所有 `reject(handlePiError(...))` 和 `controller.error(handlePiError(...))` 包装在 try/catch 中
5. `doGenerate` 的 `session.prompt().catch()` 中调用 `this.invalidateSession()`
6. `doStream` 的 `session.prompt().catch()` 中调用 `this.invalidateSession()`
7. `doGenerate` 和 `doStream` 的外部 try/catch 中调用 `this.invalidateSession()`

## Current File Structure

```
src/
├── convert-to-pi-messages.ts  # AI SDK → Pi 消息转换
├── errors.ts                  # 错误处理（handlePiError, createAPICallError 等）
├── index.ts                   # 导出入口
├── map-pi-finish-reason.ts    # StopReason → AI SDK finish reason 映射
├── pi-language-model.ts       # PiLanguageModel 主实现（LanguageModelV3）
├── pi-provider.ts             # createPi 和 pi 提供者工厂
├── types.ts                   # 类型定义
└── validation.ts              # 模型 ID 解析和设置校验
test/
├── convert-to-pi-messages.test.ts
├── errors.test.ts
├── map-pi-finish-reason.test.ts
├── pi-language-model.integration.test.ts  # NEW: 集成测试（默认跳过）
├── pi-language-model.test.ts             # 现有 mock 测试（新增 4 个测试）
└── validation.test.ts
```

## Learnings

### 1. handlePiError 的返回类型是 `never`

`errors.ts` 中的 `handlePiError` 函数签名是 `function handlePiError(...): never`，意味着它总是 throw，从不返回。所以调用 `reject(handlePiError(...))` 时，`reject` 实际上永远不会被执行——因为 `handlePiError` 先 throw 了。

**修复模式**：
```ts
try {
  reject(handlePiError(error, {...}));
} catch (mapped) {
  reject(mapped);
}
```

### 2. Pi SDK `session.agent.state.systemPrompt` 可写

Pi Agent 的 `state.systemPrompt` 是一个可写的 `string` 字段。即使 session 已经创建，也可以直接设置。session 会在下一次 `prompt()` 时读取这个值。文档推荐使用 `ResourceLoader` 的 `systemPromptOverride`，但运行时直接设置 state 也是可行的。

### 3. `toProviderMetadata()` 将原始值包装为对象

`SharedV3ProviderMetadata` 类型 = `Record<string, JSONObject>`，所以 `toProviderMetadata()` 将原始值（字符串、数字等）包装为 `{ value: string }` 对象。这意味着 `responseModel` 和 `responseId` 在 metadata 中呈现为 `{ value: "..." }` 的形式，使用时需要通过 `metadata.responseModel.value` 访问。

### 4. Pi SDK 的 AssistantMessage 类型

```typescript
interface AssistantMessage {
  role: "assistant";
  content: (TextContent | ThinkingContent | ToolCall)[];
  api: Api;
  provider: Provider;
  model: string;
  responseModel?: string;   // 原始模型 ID（如 "claude-sonnet-4-20250514"）
  responseId?: string;      // 响应的唯一 ID
  diagnostics?: AssistantMessageDiagnostic[];
  usage: Usage;
  stopReason: StopReason;   // "stop" | "length" | "toolUse" | "error" | "aborted"
  errorMessage?: string;
  timestamp: number;
}
```

`StopReason` 实际类型是 **camelCase**：`"stop" | "length" | "toolUse" | "error" | "aborted"`。没有 `tool_use` 值，但在底层 provider 原始响应中可能仍然出现。

### 5. vitest 测试中 `vi.waitFor` 的超时

`vi.waitFor` 默认超时 1000ms。当测试中的 Promise 永远不会 settle 时（如 handlePiError 传播 bug），`vi.waitFor` 会一直阻塞直到超时。总 test 的默认超时是 5000ms。

## Artifacts

- `test/pi-language-model.integration.test.ts` — 真实 Pi SDK 集成测试（10 个测试，默认跳过）

## Test Coverage

- `test/map-pi-finish-reason.test.ts` — 21 个测试
- `test/validation.test.ts` — 28 个测试
- `test/convert-to-pi-messages.test.ts` — 18 个测试
- `test/errors.test.ts` — 25 个测试
- `test/pi-language-model.test.ts` — 16 个测试（新增 4 个）
- `test/pi-language-model.integration.test.ts` — 10 个测试（默认跳过）
- **Total: 108 单元测试 + 10 集成测试（跳过）= 118 测试**

## Action Items & Next Steps

1. **Next.js API Route 示例项目**
   - 创建示例目录 `examples/nextjs/`
   - 包含 API Route + ai-elements 前端
   - 展示 provider 与 AI SDK 的完整集成

2. **Pi 特有功能支持**
   - **AbortSignal 桥接** — 已在代码中实现（`cleanupAbortListener`），需端到端验证
   - **streamingBehavior** — 在 `session.prompt()` 中传递 `streamingBehavior: "steer" | "followUp"` 选项
   - **session.steer() / session.followUp()** — 通过 `PiLanguageModelSettings` 暴露
   - **session.setModel() / session.setThinkingLevel()** — 动态切换模型/思考级别

3. **`[Symbol.dispose]` 支持**
   - 添加 `lib: ["ES2022", "ESNext.Disposable"]` 到 tsconfig
   - 在 PiLanguageModel 上实现 `[Symbol.dispose]()` 方法
   - 支持 `using model = pi('sonnet')` 语法
   - TypeScript 5.2+ 已经支持，Node 20+ 已经有 `Symbol.dispose`

4. **处理多轮对话历史回放**
   - 当前 `buildPromptFromContext()` 只取最后一条用户消息
   - 当 AI SDK 发送带有完整历史的消息数组时，Pi session 自身管理的状态不会包含这些历史
   - 需要研究如何将历史消息回放到 Pi session（通过 `session.agent.state.messages` 或 `session.sendCustomMessage()`）
   - 系统提示词已正确处理，但多轮对话历史（assistant/tool 消息）尚未传递

5. **README 和文档完善**
   - 更新 README 突出新功能
   - 添加迁移指南
   - 添加示例代码片段

6. **CI 配置**
   - 添加 GitHub Actions 配置
   - 确保 `pnpm test` 在 CI 中运行（单元测试）
   - 可选：在 CI 中运行集成测试（需配置 API key）

## Other Notes

### 已安装依赖版本
- `@ai-sdk/provider`: 3.0.10
- `@ai-sdk/provider-utils`: 4.0.1
- `@earendil-works/pi-coding-agent`: 0.79.1
- `@earendil-works/pi-ai`: 0.79.1
- `ai`: 6.0.201 (devDep)
- `vitest`: 3.2.4
- `typescript`: 5.6.3

### 参考项目位置
- `ai-sdk-provider-claude-code` 在 `/Volumes/VM/Agent/ai-sdk-provider-claude-code/`

### Pi SDK 文档路径
- SDK 文档：`/Users/haoyiqiang/.nvm/versions/node/v24.1.0/lib/node_modules/@earendil-works/pi-coding-agent/docs/sdk.md`
- Custom Provider 文档：`/Users/haoyiqiang/.nvm/versions/node/v24.1.0/lib/node_modules/@earendil-works/pi-coding-agent/docs/custom-provider.md`
- Pi AI 类型定义：`node_modules/@earendil-works/pi-ai/dist/types.d.ts`

### 社区参考项目
- edge-pi：`https://github.com/marcusschiesser/edge-pi` — 用 AI SDK 重写 Pi
- bunny-agent：`https://github.com/buda-ai/bunny-agent` — Pi runner + AI SDK UI native stream
