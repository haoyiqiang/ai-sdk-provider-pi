# Examples

ai-sdk-provider-pi 的使用示例。

## 快速开始

```bash
# 1. 复制环境变量配置
cp ../.env.example ../.env

# 2. 编辑 .env，配置 PI_MODEL_ID 和 API key
#    PI_MODEL_ID=deepseek-v4-flash
#    DEEPSEEK_API_KEY=sk-your-deepseek-api-key

# 3. 运行示例
npx tsx basic-generate.ts
```

> 示例通过 `dotenv` 自动读取 `../.env` 中的配置，无需手动传参。

## 示例列表

| 示例                | 文件                      | 说明                                                  |
| ------------------- | ------------------------- | ----------------------------------------------------- |
| **基础文本生成**    | `basic-generate.ts`       | 使用 `generateText()` 发送 prompt 并获取完整响应      |
| **流式响应**        | `basic-stream.ts`         | 使用 `streamText()` 逐 token 流式输出                 |
| **多轮对话**        | `conversation-history.ts` | 多轮对话，通过 `messages` 数组维护对话历史            |
| **工具执行**        | `tool-execution.ts`       | Pi 自动执行工具（read, bash 等），演示 `noTools` 选项 |
| **错误处理**        | `error-handling.ts`       | 演示错误类型守卫、元数据提取、真实 API 错误处理       |
| **自定义 Provider** | `custom-provider.ts`      | 使用 `createPi()` 配置自定义 AuthStorage 和 Logger    |

## 模型配置

通过 `.env` 的 `PI_MODEL_ID` 指定模型，支持以下格式：

```bash
# 便捷别名
PI_MODEL_ID=deepseek-v4-flash    # deepseek/deepseek-v4-flash
PI_MODEL_ID=sonnet               # anthropic/claude-sonnet-4
PI_MODEL_ID=gpt-4o               # openai/gpt-4o
PI_MODEL_ID=gemini-2.5-pro       # google/gemini-2.5-pro

# 完整格式
PI_MODEL_ID=deepseek/deepseek-v4-flash
PI_MODEL_ID=anthropic/claude-sonnet-4
```

**可选别名：** `deepseek-v4-flash`、`deepseek-v4-pro`、`deepseek-chat`、`deepseek-reasoner`、`sonnet`、`opus`、`haiku`、`gpt-4o`、`gpt-4o-mini`、`o3`、`o4-mini`、`gemini-2.5-pro`、`gemini-2.5-flash`

## API Key 配置

| 模型提供商 | 环境变量                       | 获取地址                                    |
| ---------- | ------------------------------ | ------------------------------------------- |
| DeepSeek   | `DEEPSEEK_API_KEY`             | https://platform.deepseek.com/api_keys      |
| Anthropic  | `ANTHROPIC_API_KEY`            | https://console.anthropic.com/settings/keys |
| OpenAI     | `OPENAI_API_KEY`               | https://platform.openai.com/api-keys        |
| Google     | `GOOGLE_GENERATIVE_AI_API_KEY` | https://aistudio.google.com/apikey          |

Pi 的 `AuthStorage` 会自动读取环境变量，也支持从 `~/.pi/agent/auth.json` 读取。

## 运行方式

```bash
# 使用默认模型（来自 .env）
npx tsx examples/basic-generate.ts

# 临时切换模型
PI_MODEL_ID=gpt-4o npx tsx examples/basic-generate.ts

# 使用其他 API key
DEEPSEEK_API_KEY=sk-xxx npx tsx examples/basic-generate.ts
```
