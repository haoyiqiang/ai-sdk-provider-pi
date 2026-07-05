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
  AuthStorage,
  createAgentSession,
  createBashToolDefinition,
  createEditToolDefinition,
  createLocalBashOperations,
  createReadToolDefinition,
  createWriteToolDefinition,
  ModelRegistry,
  SessionManager,
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

  // Reused session for conversation continuity
  private session: AgentSession | null = null;
  private sessionId: string | undefined;
  private disposed = false;


  constructor(options: PiLanguageModelOptions) {
    this.modelId = options.id;
    this.model = options.model;
    this.settings = options.settings;
    this.providerSettings = options.providerSettings;
    this.settingsValidationWarnings = options.settingsValidationWarnings ?? [];

    this.logger = this.resolveLogger(options.providerSettings);

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
    return {
      debug: (msg: string) => console.debug(`[pi] ${msg}`),
      info: (msg: string) => console.info(`[pi] ${msg}`),
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
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    if (this.session) {
      try {
        this.session.dispose();
        this.logger.info(`Pi session disposed: ${this.sessionId}`);
      } catch (error) {
        this.logger.error(`Error disposing Pi session: ${error}`);
      }
      this.session = null;
      this.sessionId = undefined;
    }
  }

  /**
   * Invalidates the current session without disposing the underlying Pi session.
   * Used for error recovery — when a session.prompt() fails, we clear the local
   * reference so the next call creates a fresh session automatically.
   * Unlike dispose(), this does not call session.dispose() because the session
   * may already be in a broken state.
   */
  private invalidateSession(): void {
    if (this.session) {
      this.logger.info(
        `Invalidating Pi session after error: ${this.sessionId}`,
      );
      this.session = null;
      this.sessionId = undefined;
    }
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
    this.invalidateSession();
    try {
      onError(
        handlePiError(error, {
          provider: this.model.provider,
          modelId: this.model.id,
          sessionId: this.sessionId,
        }),
      );
    } catch (mapped) {
      onError(mapped);
    }
  }


  private async ensureSession(): Promise<AgentSession> {
    if (this.disposed) {
      this.disposed = false; // Reset so a new session can be created
      this.logger.info("Creating new session after dispose()");
    }
    if (this.session) {
      return this.session;
    }
    try {
      const authStorage =
        this.providerSettings.authStorage ?? AuthStorage.create();
      const modelRegistry =
        this.providerSettings.modelRegistry ??
        ModelRegistry.create(authStorage);

      // Resolve sandbox config (model-level overrides provider-level).
      const sandbox: SandboxConfig | undefined =
        this.settings.sandbox ?? this.providerSettings.sandbox;
      const baseCwd =
        sandbox?.cwd ??
        this.settings.cwd ??
        this.providerSettings.cwd ??
        process.cwd();

      // Build custom tool definitions whose execution backing is determined by
      // the sandbox config. In 'local' mode the agent uses Pi's built-in local
      // shell/filesystem operations (no override needed). In 'custom' mode each
      // operation supplied via sandbox.operations replaces the corresponding
      // built-in tool, with any missing operation falling back to local.
      //
      // When a sandbox config is present we replace all four built-in tools so
      // the entire tool surface shares the same execution backend; otherwise
      // we leave the built-in tools untouched and only honour provider/model
      // customTools.
      const customToolDefs: any[] = [];
      const hasSandbox = sandbox !== undefined;
      if (hasSandbox) {
        const ops =
          (sandbox?.mode === "custom" ? sandbox?.operations : undefined) ?? {};
        customToolDefs.push(
          createBashToolDefinition(baseCwd, {
            operations: ops.bash ?? createLocalBashOperations(),
          }),
        );
        if (ops.read) {
          customToolDefs.push(
            createReadToolDefinition(baseCwd, { operations: ops.read }),
          );
        }
        if (ops.write) {
          customToolDefs.push(
            createWriteToolDefinition(baseCwd, { operations: ops.write }),
          );
        }
        if (ops.edit) {
          customToolDefs.push(
            createEditToolDefinition(baseCwd, { operations: ops.edit }),
          );
        }
      }

      const allCustomTools = [
        ...customToolDefs,
        ...(this.providerSettings.customTools ?? []),
      ] as any;
      const result = await createAgentSession({
        model: this.model,
        authStorage,
        modelRegistry,
        sessionManager:
          this.providerSettings.sessionManager ?? SessionManager.inMemory(),
        cwd: baseCwd,
        agentDir: this.providerSettings.agentDir,
        tools: this.settings.tools ?? this.providerSettings.tools,
        excludeTools:
          this.settings.excludeTools ?? this.providerSettings.excludeTools,
        noTools: hasSandbox ? "builtin" : this.providerSettings.noTools,
        customTools: allCustomTools,
        thinkingLevel: this.settings.thinkingLevel,
      });

      this.session = result.session;
      this.sessionId = this.session.sessionId;
      this.logger.info(`Pi session created: ${this.sessionId}`);
      return this.session;
    } catch (error) {
      throw handlePiError(error, {
        provider: this.model.provider,
        modelId: this.model.id,
      });
    }
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
                    id: this.sessionId ?? generateId(),
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
                  sessionId: this.sessionId,
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
      this.invalidateSession();
      throw handlePiError(error, {
        provider: this.model.provider,
        modelId: this.model.id,
        sessionId: this.sessionId,
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
                    sessionId: this.sessionId,
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
      this.invalidateSession();
      throw handlePiError(error, {
        provider: this.model.provider,
        modelId: this.model.id,
        sessionId: this.sessionId,
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
