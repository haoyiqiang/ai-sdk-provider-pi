# @kevinhao/ai-sdk-provider-pi

AI SDK v6 provider for [Pi Coding Agent](https://github.com/earendil-works/pi-coding-agent). Use any of Pi's 15+ LLM providers with the Vercel AI SDK's `streamText()`, `generateText()`, `useChat()`, and [ai-elements](https://vercel.com/academy/ai-sdk/ai-elements) components.

## Installation

```bash
npm install @kevinhao/ai-sdk-provider-pi ai
```

## Quick Start

```typescript
import { pi } from "@kevinhao/ai-sdk-provider-pi";
import { generateText, streamText } from "ai";

// Use the default provider with Anthropic Claude
const { text } = await generateText({
  model: pi("anthropic/claude-sonnet-4"),
  prompt: "Explain quantum computing in one paragraph.",
});

// Use convenience aliases
const { text: text2 } = await generateText({
  model: pi("sonnet"),
  prompt: "Hello!",
});

// Stream responses
const result = streamText({
  model: pi("anthropic/claude-sonnet-4"),
  prompt: "Write a haiku about programming.",
});

for await (const chunk of result.textStream) {
  process.stdout.write(chunk);
}
```

## Supported Models

Pi supports 15+ LLM providers through a unified interface. Use the `provider/model-id` format:

```typescript
// Anthropic
pi("anthropic/claude-sonnet-4");
pi("anthropic/claude-opus-4");
pi("anthropic/claude-haiku-4");

// OpenAI
pi("openai/gpt-4o");
pi("openai/o3");
pi("openai/o4-mini");

// Google
pi("google/gemini-2.5-pro");
pi("google/gemini-2.5-flash");

// Other providers: amazon-bedrock, deepseek, groq, mistral, openrouter, together, xai, ...
```

### Convenience Aliases

```typescript
pi("sonnet"); // → anthropic/claude-sonnet-4
pi("opus"); // → anthropic/claude-opus-4
pi("haiku"); // → anthropic/claude-haiku-4
pi("gpt-4o"); // → openai/gpt-4o
pi("deepseek-v4-flash"); // → deepseek/deepseek-v4-flash
pi("deepseek-v4-pro"); // → deepseek/deepseek-v4-pro
pi("deepseek-chat"); // → deepseek/deepseek-v4-flash (alias)
pi("deepseek-reasoner"); // → deepseek/deepseek-v4-pro (alias)
```

### Examples Configuration

The examples read model configuration from `.env` via `PI_MODEL_ID`:

```bash
# .env
PI_MODEL_ID=deepseek-v4-flash
DEEPSEEK_API_KEY=sk-your-deepseek-api-key
```

Run any example with:

```bash
cp .env.example .env  # 编辑配置
npx tsx examples/basic-generate.ts
```

### Examples Configuration

The examples read model configuration from `.env` via `PI_MODEL_ID`:

```bash
# .env
PI_MODEL_ID=deepseek-v4-flash
DEEPSEEK_API_KEY=sk-your-deepseek-api-key
```

Run any example with:

```bash
cp .env.example .env  # 编辑配置
npx tsx examples/basic-generate.ts
```

## Configuration

### Custom Provider

```typescript
import { createPi } from "@kevinhao/ai-sdk-provider-pi";
import { AuthStorage } from "@earendil-works/pi-coding-agent";

const pi = createPi({
  authStorage: AuthStorage.create(),
  cwd: "/path/to/project",
  noTools: "all", // Disable all tools for pure chat
});

const model = pi("anthropic/claude-sonnet-4");
```

### Model Settings

```typescript
const model = pi("anthropic/claude-sonnet-4", {
  thinkingLevel: "high",
  maxTurns: 10,
  systemPrompt: "You are a helpful coding assistant.",
  excludeTools: ["bash"],
});
```

### API Keys

Pi resolves API keys from multiple sources in priority order:

1. **Runtime overrides**: `authStorage.setRuntimeApiKey('anthropic', 'sk-...')`
2. **auth.json**: `~/.pi/agent/auth.json`
3. **Environment variables**: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, etc.
4. **Fallback resolver**: `authStorage.setFallbackResolver(...)`

```typescript
import { createPi, AuthStorage } from "@kevinhao/ai-sdk-provider-pi";

const authStorage = AuthStorage.create();
authStorage.setRuntimeApiKey("anthropic", process.env.ANTHROPIC_API_KEY!);

const pi = createPi({ authStorage });
```

## Next.js Integration

### API Route

```typescript
// app/api/chat/route.ts
import { pi } from "@kevinhao/ai-sdk-provider-pi";
import { streamText } from "ai";

export async function POST(req: Request) {
  const { messages } = await req.json();

  const result = streamText({
    model: pi("anthropic/claude-sonnet-4"),
    messages,
  });

  return result.toDataStreamResponse();
}
```

### Frontend with ai-elements

```tsx
import { useChat } from "@ai-sdk/react";
import { Conversation, Message, PromptInput } from "@ai-elements/react";

export default function Chat() {
  const { messages, input, handleInputChange, handleSubmit } = useChat();

  return (
    <Conversation>
      {messages.map((msg) => (
        <Message key={msg.id} role={msg.role} content={msg.content} />
      ))}
      <PromptInput
        value={input}
        onChange={handleInputChange}
        onSubmit={handleSubmit}
      />
    </Conversation>
  );
}
```

## Tool Execution

When using Pi with tools enabled, tool calls are automatically executed by the Pi agent and results are streamed back to the AI SDK consumer:

```typescript
import { createPi } from "@kevinhao/ai-sdk-provider-pi";

const pi = createPi({
  cwd: "/path/to/project",
  // Tools are enabled by default — Pi provides read, bash, edit, write, etc.
});

// The agent will autonomously execute tools
const { text } = await generateText({
  model: pi("anthropic/claude-sonnet-4"),
  prompt: "Read the package.json and tell me the dependencies.",
});
```

To disable tools:

```typescript
const pi = createPi({ noTools: "all" });
```

## Streaming Details

The provider bridges Pi's callback-based event system to AI SDK's `ReadableStream`:

| Pi Event                            | AI SDK Stream Part                          |
| ----------------------------------- | ------------------------------------------- |
| `message_update` + `text_delta`     | `text-delta`                                |
| `message_update` + `thinking_delta` | `reasoning-delta`                           |
| `toolcall_start`                    | `tool-input-start`                          |
| `toolcall_delta`                    | `tool-input-delta`                          |
| `toolcall_end`                      | `tool-call`                                 |
| `tool_execution_start`              | `tool-input-start` (if not already emitted) |
| `tool_execution_end`                | `tool-result`                               |
| `agent_end`                         | `finish`                                    |

## API Reference

### `createPi(options?)`

Creates a Pi provider instance.

**Options:**

- `authStorage` — Custom AuthStorage instance
- `modelRegistry` — Custom ModelRegistry instance
- `sessionManager` — Custom SessionManager (defaults to in-memory)
- `cwd` — Working directory
- `agentDir` — Pi agent directory
- `tools` — Tool whitelist
- `excludeTools` — Tool blacklist
- `noTools` — `'all'` or `'builtin'` to suppress tools
- `customTools` — Custom tool definitions
- `verbose` — Enable verbose logging
- `logger` — Custom Logger or `false` to disable

### `pi(modelId, settings?)`

Creates a language model instance (shorthand for `createPi()(modelId, settings)`).

**Model Settings:**

- `thinkingLevel` — `'off'` | `'minimal'` | `'low'` | `'medium'` | `'high'` | `'xhigh'`
- `maxTurns` — Maximum agent turns
- `systemPrompt` — Custom system prompt
- `appendSystemPrompt` — Append to system prompt
- `cwd` — Working directory override
- `tools` / `excludeTools` — Tool configuration
- `maxBudgetUsd` — Maximum budget
- `maxToolResultSize` — Tool result truncation size (default: 10000)

## Architecture

```
┌─────────────────┐     ┌──────────────────┐     ┌──────────────────┐
│  AI SDK         │     │  ai-sdk-provider- │     │  Pi Coding Agent │
│  streamText()   │────▶│  pi               │────▶│  session.prompt()│
│  generateText() │◀────│  PiLanguageModel  │◀────│  session.subscribe()│
│  useChat()      │     │  doStream()       │     │  (callback events)│
└─────────────────┘     └──────────────────┘     └──────────────────┘
                              │                        │
                              │                        ▼
                              │                 ┌──────────────────┐
                              │                 │  15+ LLM APIs    │
                              │                 │  Anthropic, OpenAI,
                              │                 │  Google, Mistral,
                              │                 │  Bedrock, ...    │
                              │                 └──────────────────┘
```

## License

MIT
