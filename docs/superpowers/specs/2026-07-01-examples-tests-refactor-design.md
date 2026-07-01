# Design: Examples, Test Coverage, and Code Refactoring

## Date
2026-07-01

## Status
Approved

## Overview

为 `ai-sdk-provider-pi` 项目补充 CLI 示例、完善测试覆盖、并进行聚焦的重构（提取重复逻辑）。

## Scope

三个并行工作流：

1. **Examples** — 新增 6 个 CLI 脚本示例
2. **Test Coverage** — 新建 `pi-provider.test.ts`，补充现有测试文件的缺口
3. **Refactoring (B+)** — 在 `PiLanguageModel` 中提取 4 个私有 helper 方法

## 1. Examples（`examples/` 目录）

### 1.1 文件结构

```
examples/
  basic-generate.ts        — generateText 基本用法
  basic-stream.ts          — streamText + for await
  tool-execution.ts        — 工具执行（读文件、搜索）
  custom-provider.ts       — createPi + 自定义 authStorage
  error-handling.ts        — try/catch + 错误类型判断
  conversation-history.ts  — 多轮对话 + system prompt
```

### 1.2 各示例详情

**basic-generate.ts**
- 使用默认 `pi` provider
- 调用 `generateText({ model: pi('sonnet'), prompt })`
- 输出 text、usage、finishReason
- 错误处理：try/catch
- 资源清理：model.dispose()

**basic-stream.ts**
- 使用默认 `pi` provider
- 调用 `streamText({ model: pi('sonnet'), prompt })`
- 使用 `for await (const chunk of result.textStream)` 输出
- 展示 fullStream 获取 reasoning/tool 信息

**tool-execution.ts**
- 使用 `createPi({ cwd })`
- 让 agent 执行 `read` / `bash` 工具
- 展示 tool-call 和 tool-result 出现在输出中
- 展示 `noTools: 'all'` 禁用工具

**custom-provider.ts**
- 使用 `createPi({ authStorage, logger })`
- 展示自定义 AuthStorage 和 ModelRegistry
- 展示多模型切换

**error-handling.ts**
- 展示 try/catch 捕获 `APICallError`
- 使用 `isAuthenticationError` / `isTimeoutError` / `isContextOverflowError` 判断
- 使用 `getErrorMetadata` 提取元数据

**conversation-history.ts**
- 展示多轮对话（messages 数组）
- 展示 system prompt
- 展示 `appendSystemPrompt`
- 展示 session 复用（两次 doGenerate 使用同一 session）

## 2. 测试覆盖

### 2.1 新建文件：`test/pi-provider.test.ts`

测试 `createPi()` 工厂函数：

- 返回可调用函数（provider as function）
- `.languageModel()` 创建 PiLanguageModel
- `.chat()` 等同于 `.languageModel()`
- `.specificationVersion === 'v3'`
- `.embeddingModel()` 抛出 NoSuchModelError
- `.imageModel()` 抛出 NoSuchModelError
- provider 设置合并（provider-level cwd fallback to model-level）
- provider 设置合并（tools/excludeTools fallback）
- 默认 export `pi` 可正常使用

### 2.2 补充：`test/convert-to-pi-messages.test.ts`

- `file` 类型 — Uint8Array 数据 + image mediaType
- `file` 类型 — URL 数据 → 产生 warning
- `file` 类型 — base64 string 数据
- `tool-result` — `error-json` 输出 → isError: true
- `tool-result` — `content` 类型输出
- 空 assistant content 数组 → 返回 null，不加入 messages
- 多个 tool-result 在一个 tool message 中
- image 对象格式（非 string）→ convertImagePart
- image URL 对象（new URL('https://...')）→ null + warning

### 2.3 补充：`test/pi-language-model.test.ts`

- `truncateToolResult` — 小于 maxSize 完整返回
- `truncateToolResult` — 大于 maxSize 截断并标注
- `truncateToolResult` — 自定义 maxToolResultSize
- abort 在 doGenerate 中的行为 — 提前 abort 后 session.abort 被调用
- `extractToolCallFromPartial` — invalid content 返回 null
- `extractToolCallFromPartial` — content 非数组返回 null
- `generateAllWarnings` — 所有 7 个 unsupported 参数
- `createEmptyUsage` — 返回正确的结构

## 3. 重构（B+）

### 3.1 目标

消除 `doGenerate` 和 `doStream` 中真正重复的代码，不改变公共 API。

### 3.2 提取 4 个私有 helper

**`#extractMessageEndData(event)`**
- 输入：message_end 事件
- 输出：`{ usage, finishReason, piMeta }`
- 替代位置：doGenerate L262-264, doStream L486-488

**`#setupAbortHandler(signal, session)`**
- 输入：AbortSignal, AgentSession
- 输出：cleanup function
- 替代位置：doGenerate L221-231, doStream L527-536

**`#handlePromptError(error)`**
- 输入：error, unsubscribe, cleanup, controller?
- 行为：unsubscribe + cleanup + invalidateSession + controller.error/reject
- 替代位置：doGenerate L303-312, doStream L538-546

**`#finalizeStreamParts(controller, activeTextId, activeReasoningId, startTime, piMeta, finishReason, usage)`**
- 关闭未完成的 text/reasoning parts
- 发送 finish 事件
- 关闭 controller
- 清理 abort listener 和 unsubscribe
- 替代位置：doStream L494-509

### 3.3 不改动

- 公共 API（`PiLanguageModel` 的所有 public 方法签名）
- `doGenerate` 和 `doStream` 的调用方式
- `convertToPiMessages`、`errors`、`mapPiFinishReason`、`validation` 模块

## 4. 文件变更清单

| 操作 | 文件 | 说明 |
|------|------|------|
| 新增 | `examples/basic-generate.ts` | 基本 generateText |
| 新增 | `examples/basic-stream.ts` | 基本 streamText |
| 新增 | `examples/tool-execution.ts` | 工具执行 |
| 新增 | `examples/custom-provider.ts` | 自定义 provider |
| 新增 | `examples/error-handling.ts` | 错误处理 |
| 新增 | `examples/conversation-history.ts` | 多轮对话 |
| 新增 | `test/pi-provider.test.ts` | createPi 工厂测试 |
| 修改 | `test/convert-to-pi-messages.test.ts` | 补充 9 个测试 |
| 修改 | `test/pi-language-model.test.ts` | 补充 8 个测试 |
| 修改 | `src/pi-language-model.ts` | 提取 4 个 helper |

## 5. 不变更

- 公共 API 签名
- README
- 构建配置
- `convert-to-pi-messages.ts` 产品代码
- `errors.ts` 产品代码
- `map-pi-finish-reason.ts` 产品代码
- `validation.ts` 产品代码
- `types.ts` 产品代码
- `pi-provider.ts` 产品代码（除 `PiLanguageModel` 的 helper 外）
