# PRD: Implementation Improvements for ai-sdk-provider-pi

## Problem Statement

As the author of `@kevinhao/ai-sdk-provider-pi`, I compared my implementation against a reference implementation (`ai-sdk-provider-pi-npm`, reverse-engineered from published artifacts). The comparison surfaced a set of correctness, reliability, and maintainability gaps that hurt my users today, even though the public API shape is sound:

1. **Concurrency is unsafe.** Two `doGenerate` calls on the same `PiLanguageModel` race against a single Pi `AgentSession`, and the second `session.prompt()` is fired while the first is still running. Behavior is undefined.
2. **Error classification is brittle.** `handlePiError` discriminates error types by substring matching on `error.message`, including dangerous substrings like `"auth"` and `"401"` that match unrelated messages. There is no `AbortError` type, so aborts are indistinguishable from generic failures.
3. **Retry never happens.** `APICallError.isRetryable` is hardcoded for the rate-limit case and defaults to `false` everywhere else. The AI SDK's built-in retry on 5xx / 429 / network reset is therefore inert for this provider.
4. **Structured overflow detection is missing.** `@earendil-works/pi-ai` already exposes a context-overflow detector; I ignore it and rely on message strings.
5. **Multi-turn history is lost on the first call.** I convert the full conversation to Pi messages, then call `buildPromptFromContext` and only send the last user message's text. Any prior turns the user passed in their `ModelMessage[]` are dropped until the session has replayed them itself.
6. **Usage numbers are incomplete.** `extractUsage` does not compute `noCache` and leaves `outputTokens.text` as `undefined`, so consumers cannot report uncached input tokens or text-vs-reasoning output split.
7. **Tool result truncation loses structure and can throw.** It returns a flat string and `JSON.stringify`s the raw result directly, which throws on circular references and produces unreadable output for object results.
8. **Streaming consumers miss early metadata.** `doStream` does not emit a `response-metadata` event, so timestamps and model IDs are only available at the `finish` part.
9. **`verbose` does nothing.** `resolveLogger` never reads `providerSettings.verbose`, but documentation advertises verbose logging.
10. **Processes leave sessions behind on exit.** There is no `process.on('exit')` cleanup, so crashed processes can leave dangling Pi session state.
11. **Unknown settings are silently ignored.** No strict validation rejects typos like `{ cwdd: ... }` or invalid logger shapes at construction time.
12. **Migrated users get no feedback when their `tools` / `toolChoice` are ignored.** Pi executes its own built-in tools, but I never warn that user-supplied `options.tools` and `options.toolChoice` have no effect.
13. **Maintainability.** `pi-language-model.ts` is a 1019-line monolith that inlines session management, stream mapping, abort handling, tool handling, and usage parsing. It is hard to test and hard to extend.

None of these are blocking a single happy-path run, but together they make the provider unreliable in production and hard to evolve.

## Solution

Make the provider correct under concurrency, honest about errors, trustworthy about usage and metadata, and modular enough to extend — without changing the public `PiProvider` / `PiLanguageModel` interface or the behaviour that existing tests assert.

Concretely:

- Split the monolith into cooperating modules behind the same public class.
- Add a per-session serialization queue so concurrent calls are safe.
- Rewrite error classification to prefer structural fields (`error.statusCode`, `error.code`, `error.name`, `AbortSignal`, pi-ai's `isContextOverflow`) over substring matching, and expose a `retryable` bit that the AI SDK can act on.
- Seed the Pi session with the full converted conversation history so a single `doGenerate` with a multi-turn `ModelMessage[]` carries context.
- Complete usage fields and tool-result truncation to structured values.
- Emit `response-metadata` early in `doStream`.
- Make `verbose` actually gate debug/info logs, run `process.on('exit')` cleanup, validate settings strictly, and warn when user-supplied `tools` / `toolChoice` are ignored.

The user-facing surface (`createPi`, `pi`, `PiLanguageModel.doGenerate` / `doStream` signatures, exported error guards) stays the same; only the behaviour inside improves.

## User Stories

1. As a provider author, I want concurrent `doGenerate` calls on the same model to be safe, so that I do not corrupt a Pi session by issuing overlapping `session.prompt()` calls.
2. As a provider author, I want concurrent `doStream` calls on the same model to be safe, so that streaming and one-shot calls on the same model do not interleave their events.
3. As a provider author, I want a per-session prompt queue, so that calls to the same session execute in arrival order rather than concurrently.
4. As a provider author, I want concurrent calls to _different_ models (different sessions) to run in parallel, so that serialization is per-session, not global.
5. As a developer using the provider, I want aborts to be reported as a distinct, non-retryable error type, so that I can tell a user-initiated cancel apart from a server failure.
6. As a developer using the provider, I want authentication errors to be reported as `LoadAPIKeyError`, so that AI SDK's auth-handling paths trigger correctly.
7. As a developer using the provider, I want context-overflow errors to be detected structurally (from the pi-ai SDK), so that I am not blindsided when a model's error message wording changes.
8. As a developer using the provider, I want transient errors (5xx, 429, network reset, timeout) to be marked retryable, so that the AI SDK's retry logic actually retries them.
9. As a developer using the provider, I want persistent 4xx errors (other than 429) to be marked non-retryable, so that the AI SDK does not waste calls retrying client mistakes.
10. As a developer using the provider, I want a multi-turn `messages` array passed to a single `generateText` call to carry the full conversation, so that the model has the prior turns as context on the first call.
11. As a developer using the provider, I want conversion of conversation history into the Pi session to be observable and warning-emitting, so that I can debug "the model forgot earlier turns."
12. As a developer using the provider, I want `usage.inputTokens.noCache` to be computed, so that I can report uncached input-token consumption accurately.
13. As a developer using the provider, I want `usage.outputTokens.text` to be populated, so that I can distinguish text output from reasoning output in usage reporting.
14. As a developer using the provider, I want `usage.raw` to be a normalized object, so that downstream tooling can rely on its keys rather than guessing the pi-ai shape.
15. As a developer using the provider, I want truncated tool results to expose a `truncated` flag, a `maxSize`, and a `preview`, so that my consumer code can branch on whether truncation happened.
16. As a developer using the provider, I want tool results containing circular references to truncate gracefully, so that streaming does not crash on pathological tool output.
17. As a developer using the provider, I want a `response-metadata` stream part early in the stream, so that I can surface timestamp and model ID before the stream finishes.
18. As a developer using the provider, I want `verbose: true` to actually enable debug/info logs and `verbose: false` to silence them, so that the documented verbosity setting does what it says.
19. As a developer using the provider, I want unknown settings keys to be rejected, so that I discover typos like `cwdd` instead of `cwd` at construction time.
20. As a developer using the provider, I want an invalid `logger` shape to be rejected, so that a misconfigured logger fails fast instead of silently no-oping.
21. As a developer using the provider, I want a warning when I pass `options.tools` that Pi will ignore, so that I do not assume my tool definitions are in effect.
22. As a developer using the provider, I want a warning when I pass `options.toolChoice` that is only advisory, so that I do not rely on it enforcing behaviour.
23. As a developer using the provider, I want Pi sessions to be cleaned up when the Node process exits, so that crashed processes do not leave dangling session state.
24. As a developer using the provider, I want `dispose()` to remain safe to call multiple times and after an error, so that I can put it in a `finally` block without thinking.
25. As a maintainer, I want the Pi-event → AI-SDK-stream-part mapping to live in its own pure module, so that I can unit-test it without a mock session.
26. As a maintainer, I want the tool-call / tool-result mapping to live in its own module, so that truncation and argument-stringification are testable in isolation.
27. As a maintainer, I want session acquisition and lifecycle to live in its own module, so that `PiLanguageModel` focuses on orchestration rather than plumbing.
28. As a maintainer, I want the error-mapping layer to be a pure module, so that classification logic is testable without constructing a full model.
29. As a maintainer, I want to preserve the existing public exports and call signatures, so that existing consumers (and the README examples) keep working.
30. As a maintainer, I want changes to be covered by extending existing test seams, so that I do not proliferate test scaffolding.
31. As a maintainer, I want a fresh, independent seam for the extracted stream-mapper, so that I can assert event→part mappings exhaustively without driving a full mock session through `doStream`.
32. As a developer using the provider, I want `PiProviderMetadata.sessionId` to still flow through both `doGenerate`'s `providerMetadata` and `doStream`'s `finish` part, so that I can correlate logs to sessions.
33. As a developer using the provider, I want my `SandboxConfig` and model-alias features to keep working, so that this improvement work does not regress what my implementation already gets right.
34. As a developer migrating from the OpenAI provider, I want warnings that explain which AI SDK call options I am passing are unsupported by Pi, so that I know what to drop from my existing call site.
35. As a developer running the integration suite, I want the real-model integration tests to keep passing under the improved implementation, so that the refactor is behaviour-preserving on the happy path.

## Implementation Decisions

### Module boundaries

- Extract a session-management module responsible for acquiring, caching, serializing, and disposing `AgentSession` instances. The current `ensureSession`, `dispose`, and `invalidateSession` logic moves there. `PiLanguageModel` holds a reference to it and delegates.
- Extract a stream-mapper module: a pure function that takes a `AgentSessionEvent` plus a small mutable `StreamMapperContext` (open text/reasoning part ids, tool-state map, max-tool-result size, accumulated warnings, stream-started flag) and returns the list of `LanguageModelV3StreamPart` to emit. No `this`, no `controller` dependency. `doStream` becomes a thin loop: subscribe → push events through the mapper → enqueue → close.
- Extract a tool-mapper module: `mapPiToolCall`, `mapPiToolResult`/`mapPiToolExecutionResult`, plus `safeStringify` and a structured `truncateJsonValue` returning `{ truncated, maxSize, preview }`.
- Extract an error module upgrade: keep `handlePiError` as the single entry point, but back its classification with structural helpers (`getStatusCode`, `hasNamedError`, `getObjectString`, `getErrorAssistantMessage`) and an `isRetryableError` decision. Import the upstream pi-ai context-overflow detector and call it on the `AssistantMessage` embedded in the error before falling back to message matching.
- Keep `convert-to-pi-messages`, `map-pi-finish-reason`, `validation`, and `types` as they are, only extending them where a decision below requires it.

### Concurrency

- A per-session serialization queue (a `Promise` chain keyed by session identity) gates every `session.prompt()` invocation. Calls to different sessions run in parallel; calls to the same session run strictly in arrival order.
- The queue is owned by the extracted session module so both `doGenerate` and `doStream` share it.
- Error invalidation (emptying the cached session so the next call builds a fresh one) stays, and remains inside the serialized critical section so a torn-down session is not reused by a queued call.

### Error classification (structural-first)

- Discriminator order: (1) already an `APICallError`/`LoadAPIKeyError` → rethrow; (2) `AbortError` by `error.name`, or an `AbortSignal`-aborted context → a non-retryable abort error; (3) HTTP `statusCode`/`status` field present → 401/403 → auth, 429 → retryable rate limit, 5xx → retryable, other 4xx → non-retryable; (4) `error.code` of `ETIMEDOUT`/`ECONNABORTED` → retryable timeout; (5) an `AssistantMessage` is recoverable from the error and `isContextOverflow` returns true → non-retryable context overflow; (6) message-substring matching as a last resort, using phrases long enough to avoid false positives (e.g. `"api key"`, not `"auth"`; `"timed out"`, not `"timeout"` alone).
- A new `isAbortError` guard joins the exported `isAuthenticationError` / `isTimeoutError` / `isContextOverflowError`.
- `PiErrorMetadata` gains a stable `code` vocabulary: `AUTH_FAILED`, `TIMEOUT`, `ABORTED`, `CONTEXT_OVERFLOW`, `RATE_LIMIT`, `UNKNOWN`. The existing error guards continue to work off `error.data.code`.

### Retryable policy

- Retryable: timeout, 429, 5xx, `ETIMEDOUT`/`ECONNABORTED`, message matches `rate limit` / `temporarily unavailable` / `connection reset` / `ECONNRESET`.
- Non-retryable: auth errors, abort errors, context overflow, other 4xx.
- Unknown / no structural signal: non-retryable (fail safe).

### Conversation history seeding

- When `convertToPiMessages` yields a `Context` with prior messages (assistant turns, tool results, prior user turns before the latest), seed the Pi session's agent state with those messages before issuing `session.prompt()`, rather than sending only the latest user-message text.
- `buildPromptFromContext` is kept as the "what does this turn's user prompt text reduce to" helper, but is no longer the only thing sent to the model when history exists.
- Warnings are emitted when the history contains message shapes Pi cannot represent, matching the existing conversion-warning pattern.

### Usage mapping

- `inputTokens.noCache` = `cacheRead > 0 ? max(input - cacheRead, 0) : input`.
- `outputTokens.text` = `usage.output` (text output; reasoning split left `undefined` where pi-ai does not separate them).
- `raw` is a normalized object: `{ input, output, cacheRead, cacheWrite, totalTokens, cost }`.

### Tool result truncation

- `truncateJsonValue(value, maxSize)` returns a structured `{ truncated: true, maxSize, preview }` once serialization exceeds `maxSize`, and the original value otherwise.
- `safeStringify` catches cycles / `BigInt` / throw-on-stringify and falls back to `String(value)`.
- `toJsonValue` recursively normalizes arbitrary tool output into JSON-safe values before truncation.

### Streaming metadata

- The stream-mapper emits a `response-metadata` part (`{ timestamp, modelId }`) at the assistant message `start` sub-event, before any text/reasoning/tool deltas.
- The existing `finish` part continues to carry the full `PiProviderMetadata` via `toProviderMetadata`.

### Verbose gating

- `resolveLogger` reads `providerSettings.verbose`. When `verbose` is falsy, `debug` and `info` are silenced (no-op); `warn` and `error` always pass. When `verbose` is true, all four pass. `logger: false` continues to silence everything.

### Process exit cleanup

- The session module registers a `process.on('exit')` handler that synchronously disposes cached sessions, and de-registers it on its own `dispose()`.
- `dispose()` remains idempotent and safe after prior invalidation.

### Strict settings validation

- Settings validation gains a strict mode that rejects unknown keys, so `{ cwdd: '/x' }` throws at `createPi` / model-construction time rather than silently being ignored.
- The `logger` field is validated as either `false` or an object exposing all four of `debug/info/warn/error` as functions.

### Call-option warnings

- `generateAllWarnings` (or its successor) warns when `options.tools` is non-empty (Pi ignores it; tools are built-in/sandbox-configured) and when `options.toolChoice` is set (advisory only).
- The existing unsupported-parameter warnings (`temperature`, `topP`, `topK`, `presencePenalty`, `frequencyPenalty`, `stopSequences`, `seed`) are unchanged.

### Preserved behaviour (deliberately unchanged)

- The `PiProvider` / `PiLanguageModel` public surface: `createPi`, `pi`, `languageModel`, `chat`, `embeddingModel`, `imageModel`, `doGenerate`, `doStream`, `dispose`, `provider`, `modelId`, `specificationVersion`, `defaultObjectGenerationMode`, `supportsImageUrls`, `supportsStructuredOutputs`.
- `SandboxConfig` semantics, model aliases in `parseModelId`, the `PiProviderMetadata` field set, the `PI_INTEGRATION_TEST` gate.
- All existing unit and integration tests' happy-path assertions (the refactor is behaviour-preserving on the cases they cover).

### Schema / contract sketch (from the prototype seam)

The stream-mapper's decision shape, which the new independent seam will assert exhaustively:

```
mapPiEventToStreamParts(event, ctx) => { parts: StreamPart[], streamStarted: boolean }
ctx = { toolState: Map<key, ToolStreamState>, maxToolResultSize, warnings, streamStarted }
// assistantMessageEvent sub-events:
//   start            -> [response-metadata]  (NEW)
//   text_start       -> [text-start]
//   text_delta       -> [text-delta]
//   text_end         -> [text-end]
//   thinking_*       -> [reasoning-start / reasoning-delta / reasoning-end]
//   toolcall_start   -> [tool-input-start]  + ctx.toolState set
//   toolcall_delta   -> [tool-input-delta]
//   toolcall_end     -> [tool-input-end, tool-call]
// done               -> [finish]  (usage + finishReason + providerMetadata)
// error              -> [finish]  (error finishReason + usage)
// tool_execution_start -> [tool-input-start] if not already emitted
// tool_execution_end   -> [tool-result]  (structured, safeStringify, truncateJsonValue)
```

This is the contract the new `stream-mapper` seam verifies directly, instead of indirectly through `doStream`.

## Testing Decisions

### What makes a good test here

- Tests assert external behaviour of public seams only: given inputs (events, options, errors, settings), assert the observable outputs (stream parts, content arrays, thrown error types and `data`, warnings, usage fields). They do not assert on private method internals or call counts beyond what the seam already implies.
- Tests do not couple to implementation module boundaries; if `doStream` is refactored, the mock-session tests still pass because they assert on stream parts.
- For pure extracted modules, tests are direct unit tests (inputs → outputs) with no mocks.

### Seams

- **Primary, reused:** the mock-session seam already in `test/pi-language-model.test.ts`. Emit `AgentSessionEvent`s through the mock session, assert on `doGenerate`'s returned content / finishReason / usage / warnings / providerMetadata and on `doStream`'s part sequence. This covers retryable/abort/overflow/error classification end-to-end (the model calls `handlePiError` internally), response-metadata emission, tool-truncation behaviour through the stream, and verbose gating (via a captured logger).
- **Extended, same seam:** a concurrency test drives two concurrent `doGenerate` calls on the same model through the mock session and asserts the second `session.prompt()` does not start until the first resolves/rejects — proving serialization without a new seam.
- **New, independent:** `test/stream-mapper.test.ts` targets the extracted pure mapper directly. This is the only new seam. It exhaustively covers every `AgentSessionEvent` subtype → `LanguageModelV3StreamPart` mapping, including the new `response-metadata` part, tool state tracking across `toolcall_*`, and structured `tool-result` truncation. Driving these through full `doStream` would be needlessly indirect; the new seam makes the contract precise.
- **Reused pure-module pattern, no new seam:** the new `error` classification helpers and `tool-mapper` functions are unit-tested in `test/errors.test.ts` and a `test/tool-mapper.test.ts` using the same input→output style as `convert-to-pi-messages.test.ts` and `validation.test.ts`. `tool-mapper.test.ts` is a second file but tests an existing-pattern seam (pure function), consistent with the "fewest seams" principle.
- **Integration, reused:** `test/integration/*.real.test.ts` (gated by `PI_INTEGRATION_TEST`) stays. After the refactor, the happy-path real-model runs must still pass, proving behaviour preservation and that conversation-history seeding actually carries context on a real model.

### Prior art

- `test/convert-to-pi-messages.test.ts` is the template for pure-module unit tests (input object → assert output + warnings).
- `test/errors.test.ts` is the template for classification tests (construct an error → assert the mapped type and `data`).
- `test/pi-language-model.test.ts`'s `createMockSession` / `emitEvent` pattern is the template for mock-session behavioural tests.
- `test/integration/do-generate.real.test.ts`'s multi-turn test is the anchor that proves conversation history seeding on a real model.

## Out of Scope

- Changing the public `PiProvider` / `PiLanguageModel` API surface or any exported name/signature.
- Replacing `@earendil-works/pi-ai` / `@earendil-works/pi-coding-agent` with a different upstream package.
- Supporting `imageModel` / `embeddingModel` (they remain `NoSuchModelError`).
- Native structured-outputs enforcement (`supportsStructuredOutputs` stays `false`); the existing best-effort JSON guidance is unchanged.
- New examples or README changes beyond what is strictly required to reflect `verbose` and new warnings.
- Rewriting `convert-to-pi-messages` (only extended minimally for history seeding).
- Adding multi-model session pooling or session-disk persistence beyond what the current `SessionManager` selection already does.
- Re-introducing zod as a dependency (strict validation is implemented with hand-written checks, matching the current no-zod stance).
- Performance benchmarking / token-cost optimisation.

## Further Notes

- Order of implementation (recommended, since later items lean on earlier ones):
  1. Extract `stream-mapper` + add `test/stream-mapper.test.ts`; route `doStream` through it. Introduce `response-metadata` here.
  2. Extract `tool-mapper` (structured truncation, `safeStringify`); wire into both mapper and `doGenerate`'s tool-result handling.
  3. Extract `session` module; move `ensureSession`/`dispose`/`invalidateSession` there and add the serialization queue + `process.on('exit')` cleanup. Add the concurrency test.
  4. Rewrite `errors` classification (structural-first + retryable + pi-ai `isContextOverflow` + `AbortError`); keep `handlePiError` as the entry point. Extend `test/errors.test.ts`.
  5. Seed conversation history in `ensureSession` path; extend the integration multi-turn test and add a mock-session test asserting prior turns reach the session.
  6. Complete usage fields (`noCache`, `text`, normalized `raw`) in `extractUsage`; unit-test directly.
  7. Make `verbose` gate logs in `resolveLogger`; mock-session test with a captured logger.
  8. Strict settings validation + `tools`/`toolChoice` warnings; extend `test/validation.test.ts`.
- Every step should leave the suite green; the integration suite (when `PI_INTEGRATION_TEST=true`) is the behaviour-preservation backstop.
- The `ai-sdk-provider-pi-npm` reference implementation is the source of several techniques (serialization queue, structural error helpers, `safeStringify`, structured truncation, `noCache` computation) and should be consulted for shape, not copied wholesale — it lacks `SandboxConfig`, model aliases, `PiProviderMetadata.responseId/responseModel`, and the integration suite that this implementation already has.
