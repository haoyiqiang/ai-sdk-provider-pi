import type {
  JSONObject,
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
  Model,
  Usage as PiUsage,
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
import { mapPiFinishReason } from "./map-pi-finish-reason.js";
import type {
  Logger,
  PiLanguageModelOptions,
  PiLanguageModelSettings,
  PiProviderMetadata,
  PiProviderSettings,
  SandboxConfig,
  ToolStreamState,
} from "./types.js";

/**
 * Converts PiProviderMetadata to AI SDK's SharedV3ProviderMetadata.
 * SharedV3ProviderMetadata = Record<string, JSONObject>, so we need to wrap
 * primitive values in objects.
 */
function toProviderMetadata(
  meta: PiProviderMetadata,
): SharedV3ProviderMetadata {
  const result: Record<string, JSONObject> = {};
  for (const [key, value] of Object.entries(meta)) {
    if (value != null && typeof value === "object") {
      result[key] = value as JSONObject;
    } else if (value != null) {
      result[key] = { value: String(value) } as unknown as JSONObject;
    }
  }
  return result;
}

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

  private static readonly UNKNOWN_TOOL_NAME = "unknown_tool";
  private static readonly MAX_TOOL_RESULT_SIZE = 10_000;

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
   * Extracts usage, finishReason, and providerMetadata from a message_end event.
   */
  private extractMessageEndData(event: AgentSessionEvent): {
    usage: LanguageModelV3Usage;
    finishReason: LanguageModelV3FinishReason;
    piMeta: PiProviderMetadata;
  } {
    let usage: LanguageModelV3Usage = this.createEmptyUsage();
    let finishReason: LanguageModelV3FinishReason = {
      unified: "stop",
      raw: undefined,
    };
    let piMeta: PiProviderMetadata = {};

    if (event.type === "message_end" && event.message?.role === "assistant") {
      const msg = event.message as AssistantMessage;
      usage = this.extractUsage(msg.usage);
      finishReason = mapPiFinishReason(msg.stopReason);
      piMeta = {
        sessionId: this.sessionId,
        provider: msg.provider,
        modelId: msg.model,
        responseModel: msg.responseModel,
        responseId: msg.responseId,
      };
    }

    return { usage, finishReason, piMeta };
  }

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

  /**
   * Finalizes a doStream controller: closes any open text/reasoning parts,
   * enqueues the finish event, closes the controller, and cleans up.
   */
  private finalizeStreamParts(
    controller: ReadableStreamDefaultController<LanguageModelV3StreamPart>,
    activeTextPartId: string | undefined,
    activeReasoningPartId: string | undefined,
    startTime: number,
    piMeta: PiProviderMetadata,
    finishReason: LanguageModelV3FinishReason,
    usage: LanguageModelV3Usage,
    cleanupAbort: (() => void) | undefined,
    unsubscribe: () => void,
  ): void {
    if (activeTextPartId) {
      controller.enqueue({ type: "text-end", id: activeTextPartId });
    }
    if (activeReasoningPartId) {
      controller.enqueue({ type: "reasoning-end", id: activeReasoningPartId });
    }
    piMeta.durationMs = Date.now() - startTime;

    controller.enqueue({
      type: "finish",
      finishReason,
      usage,
      providerMetadata: toProviderMetadata(piMeta),
    });

    controller.close();
    cleanupAbort?.();
    unsubscribe();
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
      let usage: LanguageModelV3Usage = this.createEmptyUsage();
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
                  toolCalls.push({
                    toolCallId: msgEvent.toolCall.id,
                    toolName: msgEvent.toolCall.name,
                    input:
                      typeof msgEvent.toolCall.arguments === "string"
                        ? msgEvent.toolCall.arguments
                        : JSON.stringify(msgEvent.toolCall.arguments),
                  });
                }
                break;
              }
              case "message_end": {
                const endData = this.extractMessageEndData(event);
                usage = endData.usage;
                finishReason = endData.finishReason;
                piMeta = endData.piMeta;
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

      let hasStartedText = false;
      let hasStartedReasoning = false;
      let activeTextPartId: string | undefined;
      let activeReasoningPartId: string | undefined;
      const toolStates = new Map<string, ToolStreamState>();
      let finishReason: LanguageModelV3FinishReason = {
        unified: "stop",
        raw: undefined,
      };
      let usage: LanguageModelV3Usage = this.createEmptyUsage();
      let piMeta: PiProviderMetadata = {};
      let cleanupAbortListener: (() => void) | undefined;

      const stream = new ReadableStream<LanguageModelV3StreamPart>({
        start: (controller) => {
          if (allWarnings.length > 0) {
            controller.enqueue({ type: "stream-start", warnings: allWarnings });
          }

          const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
            try {
              switch (event.type) {
                case "message_update": {
                  const msgEvent = event.assistantMessageEvent;
                  const meta = toProviderMetadata(piMeta);

                  switch (msgEvent.type) {
                    case "text_delta": {
                      if (!hasStartedText) {
                        hasStartedText = true;
                        activeTextPartId = generateId();
                        controller.enqueue({
                          type: "text-start",
                          id: activeTextPartId,
                          providerMetadata: meta,
                        });
                      }
                      controller.enqueue({
                        type: "text-delta",
                        id: activeTextPartId!,
                        delta: msgEvent.delta,
                        providerMetadata: meta,
                      });
                      break;
                    }
                    case "thinking_delta": {
                      if (!hasStartedReasoning) {
                        hasStartedReasoning = true;
                        activeReasoningPartId = generateId();
                        controller.enqueue({
                          type: "reasoning-start",
                          id: activeReasoningPartId,
                          providerMetadata: meta,
                        });
                      }
                      controller.enqueue({
                        type: "reasoning-delta",
                        id: activeReasoningPartId!,
                        delta: msgEvent.delta,
                        providerMetadata: meta,
                      });
                      break;
                    }
                    case "text_start": {
                      if (!hasStartedText) {
                        hasStartedText = true;
                        activeTextPartId = generateId();
                        controller.enqueue({
                          type: "text-start",
                          id: activeTextPartId,
                          providerMetadata: meta,
                        });
                      }
                      break;
                    }
                    case "thinking_start": {
                      if (!hasStartedReasoning) {
                        hasStartedReasoning = true;
                        activeReasoningPartId = generateId();
                        controller.enqueue({
                          type: "reasoning-start",
                          id: activeReasoningPartId,
                          providerMetadata: meta,
                        });
                      }
                      break;
                    }
                    case "text_end": {
                      if (activeTextPartId) {
                        controller.enqueue({
                          type: "text-end",
                          id: activeTextPartId,
                          providerMetadata: meta,
                        });
                        activeTextPartId = undefined;
                        hasStartedText = false;
                      }
                      break;
                    }
                    case "thinking_end": {
                      if (activeReasoningPartId) {
                        controller.enqueue({
                          type: "reasoning-end",
                          id: activeReasoningPartId,
                          providerMetadata: meta,
                        });
                        activeReasoningPartId = undefined;
                        hasStartedReasoning = false;
                      }
                      break;
                    }
                    case "toolcall_start": {
                      if (activeTextPartId) {
                        controller.enqueue({
                          type: "text-end",
                          id: activeTextPartId,
                        });
                        activeTextPartId = undefined;
                        hasStartedText = false;
                      }
                      const tc = this.extractToolCallFromPartial(
                        msgEvent.partial,
                        msgEvent.contentIndex,
                      );
                      if (tc) {
                        toolStates.set(tc.id, {
                          toolCallId: tc.id,
                          toolName: tc.name,
                          args: tc.arguments,
                          startTime: Date.now(),
                          inputAccumulator: "",
                          hasEmittedStart: true,
                        });
                        controller.enqueue({
                          type: "tool-input-start",
                          id: tc.id,
                          toolName: tc.name,
                          providerExecuted: true,
                          dynamic: true,
                        });
                      }
                      break;
                    }
                    case "toolcall_delta": {
                      const tc = this.extractToolCallFromPartial(
                        msgEvent.partial,
                        msgEvent.contentIndex,
                      );
                      if (tc && toolStates.has(tc.id)) {
                        controller.enqueue({
                          type: "tool-input-delta",
                          id: tc.id,
                          delta: msgEvent.delta,
                        });
                        toolStates.get(tc.id)!.inputAccumulator +=
                          msgEvent.delta;
                      }
                      break;
                    }
                    case "toolcall_end": {
                      const toolCallId = msgEvent.toolCall.id;
                      if (toolStates.has(toolCallId)) {
                        controller.enqueue({
                          type: "tool-input-end",
                          id: toolCallId,
                        });
                        controller.enqueue({
                          type: "tool-call",
                          toolCallId,
                          toolName: msgEvent.toolCall.name,
                          input:
                            typeof msgEvent.toolCall.arguments === "string"
                              ? msgEvent.toolCall.arguments
                              : JSON.stringify(msgEvent.toolCall.arguments),
                        });
                      }
                      break;
                    }
                  }
                  break;
                }

                case "tool_execution_start": {
                  if (!toolStates.has(event.toolCallId)) {
                    toolStates.set(event.toolCallId, {
                      toolCallId: event.toolCallId,
                      toolName: event.toolName,
                      args: event.args,
                      startTime: Date.now(),
                      inputAccumulator: "",
                      hasEmittedStart: true,
                    });
                    controller.enqueue({
                      type: "tool-input-start",
                      id: event.toolCallId,
                      toolName: event.toolName,
                      providerExecuted: true,
                      dynamic: true,
                    });
                  }
                  break;
                }

                case "tool_execution_end": {
                  const resultText = this.truncateToolResult(
                    typeof event.result === "string"
                      ? event.result
                      : JSON.stringify(event.result ?? ""),
                  );
                  controller.enqueue({
                    type: "tool-result",
                    toolCallId: event.toolCallId,
                    toolName: event.toolName,
                    result: resultText as any,
                    isError: event.isError || undefined,
                    dynamic: true,
                  });
                  toolStates.delete(event.toolCallId);
                  break;
                }

                case "message_end": {
                  if (activeTextPartId) {
                    controller.enqueue({
                      type: "text-end",
                      id: activeTextPartId,
                    });
                    activeTextPartId = undefined;
                    hasStartedText = false;
                  }
                  if (activeReasoningPartId) {
                    controller.enqueue({
                      type: "reasoning-end",
                      id: activeReasoningPartId,
                    });
                    activeReasoningPartId = undefined;
                    hasStartedReasoning = false;
                  }
                  const endData = this.extractMessageEndData(event);
                  usage = endData.usage;
                  finishReason = endData.finishReason;
                  piMeta = endData.piMeta;
                  break;
                }

                case "agent_end": {
                  this.finalizeStreamParts(
                    controller,
                    activeTextPartId,
                    activeReasoningPartId,
                    startTime,
                    piMeta,
                    finishReason,
                    usage,
                    cleanupAbortListener,
                    unsubscribe,
                  );
                  break;
                }

                case "turn_start":
                case "turn_end":
                case "agent_start":
                case "message_start":
                  break;
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

  private extractToolCallFromPartial(
    partial: AssistantMessage,
    contentIndex: number,
  ): { id: string; name: string; arguments: Record<string, unknown> } | null {
    if (!partial?.content || !Array.isArray(partial.content)) {
      return null;
    }
    const item = partial.content[contentIndex];
    if (item?.type !== "toolCall") {
      return null;
    }
    const tc = item as {
      type: "toolCall";
      id: string;
      name: string;
      arguments: Record<string, unknown>;
    };
    return {
      id: tc.id || generateId(),
      name: tc.name || PiLanguageModel.UNKNOWN_TOOL_NAME,
      arguments: tc.arguments || {},
    };
  }

  private extractUsage(piUsage: PiUsage): LanguageModelV3Usage {
    return {
      inputTokens: {
        total: piUsage.input ?? undefined,
        noCache: undefined,
        cacheRead: piUsage.cacheRead ?? undefined,
        cacheWrite: piUsage.cacheWrite ?? undefined,
      },
      outputTokens: {
        total: piUsage.output ?? undefined,
        text: undefined,
        reasoning: undefined,
      },
      raw: piUsage as unknown as JSONObject,
    };
  }

  private createEmptyUsage(): LanguageModelV3Usage {
    return {
      inputTokens: {
        total: undefined,
        noCache: undefined,
        cacheRead: undefined,
        cacheWrite: undefined,
      },
      outputTokens: { total: undefined, text: undefined, reasoning: undefined },
    };
  }

  private truncateToolResult(result: string): string {
    const maxSize =
      this.settings.maxToolResultSize ?? PiLanguageModel.MAX_TOOL_RESULT_SIZE;
    if (result.length <= maxSize) {
      return result;
    }
    return `${result.slice(0, maxSize)}...[truncated ${result.length - maxSize} chars]`;
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
