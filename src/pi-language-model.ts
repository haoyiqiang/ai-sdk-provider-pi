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
import {
  DEFAULT_MAX_TOOL_RESULT_SIZE,
  mapPiToolCall,
  mapPiToolResult,
} from "./tool-mapper.js";
import { mapPiFinishReason } from "./map-pi-finish-reason.js";
import type {
  Logger,
  PiLanguageModelOptions,
  PiLanguageModelSettings,
  PiProviderMetadata,
  PiProviderSettings,
  SandboxConfig,
} from "./types.js";

import { createEmptyUsage, mapPiEventToStreamParts, toProviderMetadata, truncateToolResult, UNKNOWN_TOOL_NAME, } from "./stream-mapper.js";
import type { StreamMapperContext } from "./stream-mapper.js";

const MAX_TOOL_RESULT_SIZE = 10_000;

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
  private seedSessionHistory(
    session: AgentSession,
    context: Context,
  ): void {
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
      (session.agent.state as any).messages = priorMessages;
      this.logger.debug(
        `Seeded ${priorMessages.length} prior messages into session`,
      );
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
      const promptText = buildPromptFromContext(context);
      const allWarnings = this.generateAllWarnings(
        options,
        promptText,
        conversionWarnings,
      );
      const session = await this.ensureSession();

      // Pass system prompt to Pi session if provided
      if (context.systemPrompt) {
        session.agent.state.systemPrompt = context.systemPrompt;
      }
      // Seed prior conversation history into session
      this.seedSessionHistory(session, context);

      const cleanupAbortListener = this.setupAbortHandler(
        options.abortSignal,
        session,
      );

      let text = "";
      const thinking: string[] = [];
      const toolCalls: Array<{
        toolCallId: string;
        toolName: string;
        input: string;
      }> = [];
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
              case "message_update": {
                const msgEvent = event.assistantMessageEvent;
                if (msgEvent.type === "text_delta") {
                  text += msgEvent.delta;
                } else if (msgEvent.type === "thinking_delta") {
                  thinking.push(msgEvent.delta);
                } else if (msgEvent.type === "toolcall_end") {
                  toolCalls.push(mapPiToolCall(msgEvent.toolCall));
                }
                break;
              }
              case "message_end": {
                if (
                  event.type === "message_end" &&
                  event.message?.role === "assistant"
                ) {
                  const msg = event.message as any;
                  usage = msg.usage
                    ? {
                        inputTokens: {
                          total: msg.usage.input ?? undefined,
                          noCache: undefined,
                          cacheRead: msg.usage.cacheRead ?? undefined,
                          cacheWrite: msg.usage.cacheWrite ?? undefined,
                        },
                        outputTokens: {
                          total: msg.usage.output ?? undefined,
                          text: undefined,
                          reasoning: undefined,
                        },
                        raw: msg.usage as any,
                      }
                    : createEmptyUsage();
                  finishReason = msg.stopReason
                    ? mapPiFinishReason(msg.stopReason)
                    : { unified: "stop", raw: undefined };
                  piMeta = {
                    sessionId: this.sessionId,
                    provider: msg.provider,
                    modelId: msg.model,
                    responseModel: msg.responseModel,
                    responseId: msg.responseId,
                  };
                }
                break;
              }
              case "agent_end": {
                unsubscribe();
                cleanupAbortListener?.();
                piMeta.durationMs = Date.now() - startTime;

                const content: LanguageModelV3Content[] = [];
                for (const t of thinking) {
                  content.push({ type: "reasoning", text: t });
                }
                if (text) {
                  content.push({ type: "text", text });
                }
                for (const tc of toolCalls) {
                  content.push({
                    type: "tool-call",
                    toolCallId: tc.toolCallId,
                    toolName: tc.toolName,
                    input: tc.input,
                  });
                }

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
      const promptText = buildPromptFromContext(context);
      const allWarnings = this.generateAllWarnings(
        options,
        promptText,
        conversionWarnings,
      );
      const session = await this.ensureSession();

      // Pass system prompt to Pi session if provided
      if (context.systemPrompt) {
        session.agent.state.systemPrompt = context.systemPrompt;
      }
      // Seed prior conversation history into session
      this.seedSessionHistory(session, context);

      // Create stream mapper context (mutable state carried across invocations)
      const streamCtx: StreamMapperContext = {
        activeTextPartId: undefined,
        activeReasoningPartId: undefined,
        toolStates: new Map(),
        piMeta: {},
        usage: createEmptyUsage(),
        finishReason: { unified: "stop", raw: undefined },
        generateId,
        sessionId: this.sessionId,
        startTime,
        maxToolResultSize:
          this.settings.maxToolResultSize ?? MAX_TOOL_RESULT_SIZE,
        toProviderMetadata,
      };
      let cleanupAbortListener: (() => void) | undefined;

      const stream = new ReadableStream<LanguageModelV3StreamPart>({
        start: (controller) => {
          if (allWarnings.length > 0) {
            controller.enqueue({ type: "stream-start", warnings: allWarnings });
          }

          const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
            try {
              const parts = mapPiEventToStreamParts(event, streamCtx);
              for (const part of parts) {
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
            session,
          );

          session
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
            });
        },

        cancel: () => {
          this.logger.info("Stream cancelled by consumer");
          cleanupAbortListener?.();
          session
            .abort()
            .catch((err: unknown) =>
              this.logger.error(`Abort error on cancel: ${err}`),
            );
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
    if (options.tools && options.tools.length > 0) {
      unsupportedParams.push("tools");
    }
    if (options.toolChoice !== undefined) {
      unsupportedParams.push("toolChoice");
    }

    for (const param of unsupportedParams) {
      warnings.push({
        type: "unsupported",
        feature: param,
        details: `Pi provider does not support the ${param} parameter.`,
      });
    }
    for (const warning of this.settingsValidationWarnings) {
      warnings.push({ type: "other", message: warning });
    }
    for (const warning of conversionWarnings) {
      warnings.push({ type: "other", message: warning });
    }
    return warnings;
  }
}
