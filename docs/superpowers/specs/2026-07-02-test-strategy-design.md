# Design: Test Strategy Refactoring

## Date

2026-07-02

## Status

Approved

## Overview

重构测试架构，解决 mock 事件类型与 Pi SDK 脱节的问题。核心思路：mock 代码改用真实 Pi SDK 类型约束，集成测试改用真实模型跑。

## Scope

两个工作流：

1. **Mock 类型加固** — `pi-language-model.test.ts` 的手写事件对象改为引用 `AgentSessionEvent` 类型
2. **集成测试重构** — 拆文件、换用例、用真实模型

## 1. Mock 类型加固

### 当前问题

```typescript
// ❌ 手写对象，无类型约束
const events = [
  {
    type: 'message_update',
    assistantMessageEvent: { type: 'text_delta', delta: 'Hello' },
  },
  { type: 'message_end', message: { role: 'assistant', stopReason: 'end_turn', usage: {} } },
  { type: 'agent_end', ... },
];
```

Pi SDK 升级改字段名、改事件类型、删事件 → 不报错，测试绿灯。

### 改进方案

```typescript
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

// ✅ 用真实 SDK 类型约束
const event: AgentSessionEvent = {
  type: "message_update" as const,
  assistantMessageEvent: { type: "text_delta", delta: "Hello" },
};

// ✅ createMockSession 返回类型化的事件队列
```

### 具体改动

- `test/pi-language-model.test.ts` 中 `createMockSession()` 返回的事件使用 `AgentSessionEvent` 类型
- 所有 `subscribe` 回调中 emit 的事件变量加上类型标注
- `session.prompt()` 的 mock 用 Promise 驱动事件流，保持现有测试结构不变
- 版本升级后第一次 `pnpm typecheck` 即暴露问题

## 2. 集成测试重构

### 当前状态

- 1 个文件 `test/pi-language-model.integration.test.ts`，10 个测试
- 全是 happy path
- 全部跳过（`PI_INTEGRATION_TEST=true` 控制）
- 验证的路径 mock 已经覆盖

### 目标状态

```
test/integration/
  ├── doGenerate.real.test.ts        # 真实 doGenerate（3-4 个测试）
  ├── doStream.real.test.ts           # 真实流式（3-4 个测试）
  ├── tool-execution.real.test.ts     # 真实工具执行（3-4 个测试）
  ├── error-recovery.real.test.ts     # 真实错误场景（3-4 个测试）
  └── setup.ts                       # 公共配置
```

### 每个文件的测试内容

**doGenerate.real.test.ts**

- 基本 prompt → 返回 text（不重复单元测试的断言细节）
- system prompt 正确传递
- 多轮 messages 输入

**doStream.real.test.ts**

- 基本 prompt → textStream 产生 delta
- fullStream 包含 start/delta/finish 事件
- 流式中途 abort → 停止

**tool-execution.real.test.ts**

- 一个简单 tool 调用（如 read package.json）
- 验证 tool-call 和 tool-result 出现在流中
- noTools 禁用

**error-recovery.real.test.ts**

- 无效的 model ID → NoSuchModelError
- 空的 API key → 认证错误

### 模型选择

| 文件                          | 推荐模型            | 理由                       |
| ----------------------------- | ------------------- | -------------------------- |
| `doGenerate.real.test.ts`     | `deepseek-v4-flash` | 便宜、快，验证核心流程足够 |
| `doStream.real.test.ts`       | `deepseek-v4-flash` | 同上                       |
| `tool-execution.real.test.ts` | `sonnet`            | 工具调用能力更强，不易拒答 |
| `error-recovery.real.test.ts` | `deepseek-v4-flash` | 只测错误路径，不需要强模型 |

### 环境变量与 API Key

集成测试需要两个条件：`PI_INTEGRATION_TEST=true` 启用 + 对应模型的 API key。

参考 `.env.example`（见项目根目录）：

```env
# 启用集成测试
PI_INTEGRATION_TEST=true

# deepseek-v4-flash 使用 DeepSeek API
DEEPSEEK_API_KEY=sk-your-deepseek-api-key

# sonnet（工具执行）使用 Anthropic API
ANTHROPIC_API_KEY=sk-ant-your-anthropic-api-key
```

API key 解析链（Pi SDK 原生支持）：

1. 环境变量（如上所示）
2. `~/.pi/agent/auth.json`
3. 运行时 `authStorage.setRuntimeApiKey()`

### 控制变量

```typescript
const runIntegration = process.env.PI_INTEGRATION_TEST === 'true';
const test = runIntegration ? it : it.skip;
  test('sends prompt and returns text', async () => {
    const model = pi('deepseek-v4-flash');
    // ...
  });
});
```

维持 `PI_INTEGRATION_TEST=true` 的门禁不变。

> 注意：`.env` 文件中的变量会被 Pi SDK 自动读取（它检查 `process.env`），不需要额外加载工具。

## 3. 不变更

- 单元测试的数量和断言逻辑不变（只改类型标注）
- `PI_INTEGRATION_TEST` 环境变量名不变
- 当前 141 个测试的通过率不变

## 4. 文件变更清单

| 操作   | 文件                                                         | 说明                                 |
| ------ | ------------------------------------------------------------ | ------------------------------------ |
| 修改   | `test/pi-language-model.test.ts`                             | mock 事件加 `AgentSessionEvent` 类型 |
| 重命名 | `test/pi-language-model.integration.test.ts` → 拆成 4 个文件 |
| 删除   | `test/pi-language-model.integration.test.ts`                 | 拆完后删除                           |
| 新建   | `test/integration/doGenerate.real.test.ts`                   | 真实 doGenerate                      |
| 新建   | `test/integration/doStream.real.test.ts`                     | 真实流式                             |
| 新建   | `test/integration/tool-execution.real.test.ts`               | 真实工具                             |
| 新建   | `test/integration/error-recovery.real.test.ts`               | 真实错误                             |
| 新建   | `test/integration/setup.ts`                                  | 公共配置                             |
| 修改   | `package.json`                                               | 加 `test:integration` script         |
