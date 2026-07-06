import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3Content,
  LanguageModelV3FinishReason,
  LanguageModelV3StreamPart,
  LanguageModelV3Usage,
  SharedV3ProviderMetadata,
  SharedV3Warning,
} from "@ai-sdk/provider";
import { NoSuchModelError } from "@ai-sdk/provider";
import { generateId } from "@ai-sdk/provider-utils";
import type {
  Api,
  AssistantMessage,
  Context,
  Message,
  Model,
} from "@earendil-works/pi-ai";
import type {
  AgentSession,
  AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";

import {
  buildPromptFromContext,
  convertToPiMessages,
} from "./convert-to-pi-messages.js";
import { handlePiError } from "./errors.js";
import { PiSessionManager } from "./pi-session-manager.js";
import { mapPiFinishReason } from "./map-pi-finish-reason.js";
import {
  DEFAULT_MAX_TOOL_RESULT_SIZE,
  mapPiToolResult,
} from "./tool-mapper.js";
import type {
  Logger,
  PiLanguageModelOptions,
  PiLanguageModelSettings,
  PiProviderMetadata,
  PiProviderSettings,
} from "./types.js";

import {
  createEmptyUsage,
  extractUsage,
  mapPiEventToStreamParts,
  toProviderMetadata,
} from "./stream-mapper.js";
import type { StreamMapperContext } from "./stream-mapper.js";

/**
 * PiLanguageModel implements the AI SDK LanguageModelV3 interface
 * by bridging Pi Coding Agent's session-based API to AI SDK's
 * doStream/doGenerate pattern.
 *
 * Key differences from the Claude Code provider:
 * - Pi uses session.prompt() + session.subscribe() (callback-based)
 *   instead of query() (async iterable)
 * - Pi supports 15+ LLM providers through a unified Model abstraction
 * - Pi's session lifecycle requires explicit dispose() calls
 * - Pi events are typed differently (message_update with AssistantMessageEvent subtypes)
 */
export class PiLanguageModel implements LanguageModelV3 {
  readonly specificationVersion = "v3" as const;
  readonly defaultObjectGenerationMode = "json";
  readonly supportsImageUrls = false;
  readonly supportedUrls: Record<string, RegExp[]> = {};
  readonly supportsStructuredOutputs = false;

  readonly modelId: string;
  private readonly model: Model<Api>;
  private readonly settings: PiLanguageModelSettings;
  private readonly providerSettings: PiProviderSettings;
  private readonly logger: Logger;
  private readonly settingsValidationWarnings: string[];

  // Session manager handles creation, disposal, and serialized access
  private readonly sessionManager: PiSessionManager;

  constructor(options: PiLanguageModelOptions) {
    this.modelId = options.id;
    this.model = options.model;
    this.settings = options.settings;
    this.providerSettings = options.providerSettings;
    this.settingsValidationWarnings = options.settingsValidationWarnings ?? [];

    this.logger = this.resolveLogger(options.providerSettings);

    this.sessionManager = new PiSessionManager({
      logger: this.logger,
      model: this.model,
      settings: this.settings,
      providerSettings: this.providerSettings,
    });

    if (
      !this.modelId ||
      typeof this.modelId !== "string" ||
      this.modelId.trim() === ""
    ) {
      throw new NoSuchModelError({
        modelId: this.modelId,
        modelType: "languageModel",
      });
    }
  }

  get provider(): string {
    return "pi";
  }

  private resolveLogger(providerSettings: PiProviderSettings): Logger {
    if (providerSettings.logger === false) {
      return {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
      };
    }
    if (providerSettings.logger) {
      return providerSettings.logger;
    }
    // When verbose, all log levels pass through
    if (providerSettings.verbose) {
      return {
        debug: (msg: string) => console.debug(`[pi] ${msg}`),
        info: (msg: string) => console.info(`[pi] ${msg}`),
        warn: (msg: string) => console.warn(`[pi] ${msg}`),
        error: (msg: string) => console.error(`[pi] ${msg}`),
      };
    }
    // When not verbose (default), only warn/error pass through
    return {
      debug: () => {},
      info: () => {},
      warn: (msg: string) => console.warn(`[pi] ${msg}`),
      error: (msg: string) => console.error(`[pi] ${msg}`),
    };
  }

  /**
   * Dispose the underlying Pi session and release resources.
   * After calling dispose(), the next doGenerate/doStream call will create a fresh session.
   * Safe to call multiple times.
   */
  dispose(): void {
    this.sessionManager.dispose();
  }

  // ─── Shared Helpers ───

  /**
  /**
   * Sets up an abort signal handler for the session.
   * Returns a cleanup function to remove the listener.
   */
  private setupAbortHandler(
    abortSignal: AbortSignal | undefined,
    session: AgentSession,
  ): (() => void) | undefined {
    if (!abortSignal) {
      return undefined;
    }

    const onAbort = () => {
      session
        .abort()
        .catch((err: unknown) => this.logger.error(`Abort error: ${err}`));
    };

    abortSignal.addEventListener("abort", onAbort);

    if (abortSignal.aborted) {
      onAbort();
    }

    return () => abortSignal.removeEventListener("abort", onAbort);
  }

  /**
   * Handles a session.prompt() failure: unsubscribes, cleans up abort listener,
   * invalidates the session, and calls the provided error handler.
   */
  private handlePromptError(
    error: unknown,
    unsubscribe: () => void,
    cleanupAbort: (() => void) | undefined,
    onError: (mappedError: unknown) => void,
  ): void {
    unsubscribe();
    cleanupAbort?.();
    this.sessionManager.invalidateSession();
    try {
      onError(
        handlePiError(error, {
          provider: this.model.provider,
          modelId: this.model.id,
          sessionId: this.sessionManager.currentSessionId,
        }),
      );
    } catch (mapped) {
      onError(mapped);
    }
  }

  /**
   * Seeds prior conversation history into the Pi session.
   * All messages except the last user message (which becomes the prompt text)
   * are placed in session.agent.state.messages so the agent has full context.
   */
  private seedSessionHistory(session: AgentSession, context: Context): void {
    // Find the index of the last user message
    let lastUserIndex = -1;
    for (let i = context.messages.length - 1; i >= 0; i--) {
      if (context.messages[i].role === "user") {
        lastUserIndex = i;
        break;
      }
    }

    // All messages except the last user message are "prior" history
    let priorMessages: Message[];
    if (lastUserIndex >= 0) {
      priorMessages = [
        ...context.messages.slice(0, lastUserIndex),
        ...context.messages.slice(lastUserIndex + 1),
      ];
    } else {
      priorMessages = [...context.messages];
    }

    if (priorMessages.length > 0) {
      // Pi Coding Agent stores conversation state in agent.state; the SDK
      // type does not expose `messages` directly, but it's always present.
      const agentState = session.agent.state as {
        messages?: Message[];
      };
      if (agentState && typeof agentState === "object") {
        agentState.messages = priorMessages;
        this.logger.debug(
          `Seeded ${priorMessages.length} prior messages into session`,
        );
      } else {
        this.logger.warn(
          "Unable to seed session history: agent.state is not a mutable object",
        );
      }
    }
  }

  private async ensureSession(): Promise<AgentSession> {
    return this.sessionManager.ensureSession();
  }

  // ─── doGenerate ───

  async doGenerate(options: LanguageModelV3CallOptions): Promise<{
    content: LanguageModelV3Content[];
    finishReason: LanguageModelV3FinishReason;
    usage: LanguageModelV3Usage;
    providerMetadata?: SharedV3ProviderMetadata;
    request?: { body?: unknown };
    response?: { id: string; timestamp: Date; modelId: string };
    warnings: SharedV3Warning[];
  }> {
    const startTime = Date.now();
    try {
      const { context, warnings: conversionWarnings } = convertToPiMessages(
        options.prompt,
      );
      const promptText = this.injectStructuredOutputGuidance(
        buildPromptFromContext(context),
        options.responseFormat,
      );
      const allWarnings = this.generateAllWarnings(
        options,
        promptText,
        conversionWarnings,
      );
      // Wrap the full critical section (session setup + subscribe + prompt) in
      // the per-session serialization queue so concurrent calls on the same
      // model never issue overlapping session.prompt() invocations.
      return this.sessionManager.runSerialized((session) => {
        if (context.systemPrompt) {
          session.agent.state.systemPrompt = context.systemPrompt;
        }
        this.seedSessionHistory(session, context);
        const cleanupAbortListener = this.setupAbortHandler(
          options.abortSignal,
          session,
        );
        let finalAssistantMessage: AssistantMessage | undefined;
        const toolResults: LanguageModelV3Content[] = [];
        let finishReason: LanguageModelV3FinishReason = {
          unified: "stop",
          raw: undefined,
        };
        let usage: LanguageModelV3Usage = createEmptyUsage();
        let piMeta: PiProviderMetadata = {};
        return new Promise((resolve, reject) => {
          const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
            try {
              switch (event.type) {
                case "tool_execution_end": {
                  toolResults.push(
                    mapPiToolResult(
                      {
                        toolCallId: event.toolCallId,
                        toolName: event.toolName,
                        result: event.result,
                        isError: event.isError,
                      },
                      this.settings.maxToolResultSize ??
                        DEFAULT_MAX_TOOL_RESULT_SIZE,
                    ),
                  );
                  break;
                }
                case "message_end": {
                  if (isAssistantMessage(event.message)) {
                    finalAssistantMessage = event.message;
                    usage = event.message.usage
                      ? extractUsage(event.message.usage)
                      : createEmptyUsage();
                    finishReason = event.message.stopReason
                      ? mapPiFinishReason(event.message.stopReason)
                      : { unified: "stop", raw: undefined };
                    piMeta = {
                      sessionId: this.sessionManager.currentSessionId,
                      provider: event.message.provider,
                      modelId: event.message.model,
                      responseModel: event.message.responseModel,
                      responseId: event.message.responseId,
                    };
                  }
                  break;
                }
                case "agent_end": {
                  unsubscribe();
                  cleanupAbortListener?.();
                  piMeta.durationMs = Date.now() - startTime;
                  const content = mapAssistantMessageContent(
                    finalAssistantMessage,
                  );
                  content.push(...toolResults);
                  resolve({
                    content,
                    finishReason,
                    usage,
                    warnings: allWarnings,
                    response: {
                      id: this.sessionManager.currentSessionId ?? generateId(),
                      timestamp: new Date(),
                      modelId: this.modelId,
                    },
                    request: { body: { prompt: promptText } },
                    providerMetadata: toProviderMetadata(piMeta),
                  });
                  break;
                }
              }
            } catch (error) {
              unsubscribe();
              cleanupAbortListener?.();
              try {
                reject(
                  handlePiError(error, {
                    provider: this.model.provider,
                    modelId: this.model.id,
                    sessionId: this.sessionManager.currentSessionId,
                  }),
                );
              } catch (mapped) {
                reject(mapped);
              }
            }
          });

          session
            .prompt(promptText, { expandPromptTemplates: false })
            .catch((error: unknown) => {
              this.handlePromptError(
                error,
                unsubscribe,
                cleanupAbortListener,
                (mapped) => reject(mapped),
              );
            });
        });
      });
    } catch (error) {
      this.sessionManager.invalidateSession();
      throw handlePiError(error, {
        provider: this.model.provider,
        modelId: this.model.id,
        sessionId: this.sessionManager.currentSessionId,
      });
    }
  }

  // ─── doStream ───

  async doStream(options: LanguageModelV3CallOptions): Promise<{
    stream: ReadableStream<LanguageModelV3StreamPart>;
    request?: { body?: unknown };
  }> {
    const startTime = Date.now();
    try {
      const { context, warnings: conversionWarnings } = convertToPiMessages(
        options.prompt,
      );
      const promptText = this.injectStructuredOutputGuidance(
        buildPromptFromContext(context),
        options.responseFormat,
      );
      const allWarnings = this.generateAllWarnings(
        options,
        promptText,
        conversionWarnings,
      );
      const jsonRequested = options.responseFormat?.type === "json";
      let streamedText = "";
      // Session is created lazily inside runSerialized; no need to eagerly acquire it here.
      const streamCtx: StreamMapperContext = {
        activeTextPartId: undefined,
        activeReasoningPartId: undefined,
        toolStates: new Map(),
        piMeta: {},
        usage: createEmptyUsage(),
        finishReason: { unified: "stop", raw: undefined },
        generateId,
        sessionId: this.sessionManager.currentSessionId,
        modelId: this.modelId,
        startTime,
        maxToolResultSize:
          this.settings.maxToolResultSize ?? DEFAULT_MAX_TOOL_RESULT_SIZE,
        toProviderMetadata,
        warnings: allWarnings,
        streamStarted: false,
      };
      let cleanupAbortListener: (() => void) | undefined;
      const stream = new ReadableStream<LanguageModelV3StreamPart>({
        start: (controller) => {
          // Wrap session setup + subscribe + prompt in the per-session
          // serialization queue so concurrent doStream/doGenerate calls on
          // the same model never issue overlapping session.prompt()
          // invocations. The queue is held until prompt() resolves (i.e.
          // the turn completes), so a queued call's prompt waits for the
          // in-flight turn to finish.
          this.sessionManager
            .runSerialized((ses) => {
              // Pass system prompt to Pi session if provided
              if (context.systemPrompt) {
                ses.agent.state.systemPrompt = context.systemPrompt;
              }
              // Seed prior conversation history into session
              this.seedSessionHistory(ses, context);

              const unsubscribe = ses.subscribe((event: AgentSessionEvent) => {
                try {
                  const parts = mapPiEventToStreamParts(event, streamCtx);
                  for (const part of parts) {
                    if (jsonRequested && part.type === "text-delta") {
                      streamedText += (part as { delta: string }).delta;
                    }
                    controller.enqueue(part);
                  }
                  // Handle agent_end: close controller and clean up
                  if (event.type === "agent_end") {
                    controller.close();
                    cleanupAbortListener?.();
                    unsubscribe();
                  }
                } catch (error) {
                  this.logger.error(`Error processing Pi event: ${error}`);
                  cleanupAbortListener?.();
                  unsubscribe();
                  try {
                    controller.error(
                      handlePiError(error, {
                        provider: this.model.provider,
                        modelId: this.model.id,
                        sessionId: this.sessionManager.currentSessionId,
                      }),
                    );
                  } catch {
                    /* controller may already be closed */
                  }
                }
              });
              cleanupAbortListener = this.setupAbortHandler(
                options.abortSignal,
                ses,
              );

              return ses
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
                })
                .then(() => {
                  if (jsonRequested && !isValidJson(streamedText)) {
                    this.logger.warn(
                      "Pi structured-output request completed with non-JSON text output.",
                    );
                  }
                });
            })
            .catch((error: unknown) => {
              // runSerialized rejects only if the callback throws before
              // returning the prompt promise (e.g. subscribe setup failure).
              try {
                controller.error(
                  handlePiError(error, {
                    provider: this.model.provider,
                    modelId: this.model.id,
                    sessionId: this.sessionManager.currentSessionId,
                  }),
                );
              } catch {
                /* controller may already be closed */
              }
            });
        },

        cancel: () => {
          this.logger.info("Stream cancelled by consumer");
          cleanupAbortListener?.();
          const currentSession = this.sessionManager.currentSession;
          if (currentSession) {
            currentSession
              .abort()
              .catch((err: unknown) =>
                this.logger.error(`Abort error on cancel: ${err}`),
              );
          }
        },
      });

      return {
        stream,
        request: { body: { prompt: promptText, model: this.modelId } },
      };
    } catch (error) {
      this.sessionManager.invalidateSession();
      throw handlePiError(error, {
        provider: this.model.provider,
        modelId: this.model.id,
        sessionId: this.sessionManager.currentSessionId,
      });
    }
  }

  // ─── Helper Methods ───

  /**
   * Builds a structured output guidance preamble when JSON response format
   * is requested. Injects schema and instructions into the prompt text so
   * the Pi agent knows to produce valid JSON.
   */
  private injectStructuredOutputGuidance(
    promptText: string,
    responseFormat?: LanguageModelV3CallOptions["responseFormat"],
  ): string {
    if (responseFormat?.type !== "json") {
      return promptText;
    }
    const blocks: string[] = [
      "Output format: return valid JSON only, no markdown code fences or extra commentary.",
    ];
    const schema = responseFormat.schema;
    if (schema !== undefined) {
      try {
        blocks.push(`JSON schema:\n${JSON.stringify(schema, null, 2)}`);
      } catch {
        blocks.push(`JSON schema: ${String(schema)}`);
      }
    }
    const guidance = blocks.join("\n\n");
    this.logger.debug("Injecting structured output guidance into prompt");
    return `${guidance}\n\n${promptText}`;
  }

  private generateAllWarnings(
    options: LanguageModelV3CallOptions,
    _promptText: string,
    conversionWarnings: string[],
  ): SharedV3Warning[] {
    const warnings: SharedV3Warning[] = [];
    const unsupportedParams: string[] = [];
    if (options.temperature !== undefined) {
      unsupportedParams.push("temperature");
    }
    if (options.topP !== undefined) {
      unsupportedParams.push("topP");
    }
    if (options.topK !== undefined) {
      unsupportedParams.push("topK");
    }
    if (options.presencePenalty !== undefined) {
      unsupportedParams.push("presencePenalty");
    }
    if (options.frequencyPenalty !== undefined) {
      unsupportedParams.push("frequencyPenalty");
    }
    if (options.stopSequences?.length) {
      unsupportedParams.push("stopSequences");
    }
    if (options.seed !== undefined) {
      unsupportedParams.push("seed");
    }
    // tools and toolChoice are compatibility warnings, not unsupported.
    // Pi executes its own built-in tools — AI SDK-side tools are advisory only.

    for (const param of unsupportedParams) {
      warnings.push({
        type: "unsupported",
        feature: param,
        details: `Pi provider does not support the ${param} parameter.`,
      });
    }

    // Compatibility warnings: Pi executes its own built-in tools
    const compatibilityWarnings: Array<{ feature: string; details: string }> =
      [];
    if (options.tools && options.tools.length > 0) {
      compatibilityWarnings.push({
        feature: "tools",
        details:
          "AI SDK tools were passed, but Pi executes its own built-in tools. Passed tools are ignored.",
      });
    }
    if (options.toolChoice !== undefined) {
      compatibilityWarnings.push({
        feature: "toolChoice",
        details: `toolChoice "${String(options.toolChoice)}" is advisory only — Pi controls tool execution internally.`,
      });
    }
    for (const cw of compatibilityWarnings) {
      warnings.push({
        type: "compatibility",
        feature: cw.feature,
        details: cw.details,
      });
    }
    for (const warning of this.settingsValidationWarnings) {
      warnings.push({ type: "other", message: warning });
    }
    for (const warning of conversionWarnings) {
      warnings.push({ type: "other", message: warning });
    }
    if (options.responseFormat?.type === "json") {
      warnings.push({
        type: "compatibility",
        feature: "responseFormat",
        details:
          "JSON response format requested. Pi does not natively enforce structured outputs — JSON output is best-effort and may not validate against schema.",
      });
    }
    return warnings;
  }
}

/** Checks whether a string is valid JSON. */
function isValidJson(text: string): boolean {
  const candidate = text.trim();
  if (candidate.length === 0) {
    return false;
  }
  try {
    JSON.parse(candidate);
    return true;
  } catch {
    return false;
  }
}

/** Type guard: checks whether value is a valid Pi AssistantMessage. */
function isAssistantMessage(value: unknown): value is AssistantMessage {
  if (typeof value !== "object" || value == null) {
    return false;
  }
  const candidate = value as Partial<AssistantMessage>;
  return (
    candidate.role === "assistant" &&
    Array.isArray(candidate.content) &&
    typeof candidate.stopReason === "string"
  );
}

/** Maps a Pi AssistantMessage to AI SDK LanguageModelV3Content array. */
function mapAssistantMessageContent(
  message: AssistantMessage | undefined,
): LanguageModelV3Content[] {
  if (message == null) {
    return [];
  }
  const content: LanguageModelV3Content[] = [];
  for (const part of message.content) {
    if (part.type === "text") {
      content.push({ type: "text", text: part.text });
    } else if (part.type === "thinking") {
      content.push({ type: "reasoning", text: part.thinking });
    } else if (part.type === "toolCall") {
      content.push({
        type: "tool-call",
        toolCallId: part.id,
        toolName: part.name,
        input:
          typeof part.arguments === "string"
            ? part.arguments
            : JSON.stringify(part.arguments ?? {}),
        providerExecuted: true,
      });
    }
  }
  return content;
}
