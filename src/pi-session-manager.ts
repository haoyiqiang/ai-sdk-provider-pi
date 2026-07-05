import type { Api, Model } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
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
import { handlePiError } from "./errors.js";
import type {
  Logger,
  PiLanguageModelSettings,
  PiProviderSettings,
  SandboxConfig,
} from "./types.js";

/**
 * Manages the lifecycle of a Pi agent session, including creation,
 * disposal, invalidation, and serialized access via a Promise chain.
 *
 * Each PiLanguageModel instance owns a PiSessionManager, which holds
 * a single reusable AgentSession. The serialization queue ensures that
 * concurrent calls to `ensureSession()` are executed sequentially to
 * prevent double-creation races.
 */
export class PiSessionManager {
  private session: AgentSession | null = null;
  private sessionId: string | undefined;
  private disposed = false;

  /**
   * Promise chain tail for serializing ensureSession() calls.
   * Each call enqueues itself onto this chain, guaranteeing that
   * session creation and subsequent access do not race.
   */
  #queueTail: Promise<void> = Promise.resolve();

  /** Tracks whether the process exit handler has been registered. */
  static #exitHandlerRegistered = false;

  /** Set of active managers to clean up on process exit. */
  static #activeManagers = new Set<PiSessionManager>();

  private readonly logger: Logger;
  private readonly model: Model<Api>;
  private readonly settings: PiLanguageModelSettings;
  private readonly providerSettings: PiProviderSettings;

  constructor(options: {
    logger: Logger;
    model: Model<Api>;
    settings: PiLanguageModelSettings;
    providerSettings: PiProviderSettings;
  }) {
    this.logger = options.logger;
    this.model = options.model;
    this.settings = options.settings;
    this.providerSettings = options.providerSettings;

    PiSessionManager.#activeManagers.add(this);
    PiSessionManager.#registerExitHandler();
  }

  /** The currently active session, or null. */
  get currentSession(): AgentSession | null {
    return this.session;
  }

  /** The ID of the currently active session, or undefined. */
  get currentSessionId(): string | undefined {
    return this.sessionId;
  }

  /** Whether this manager has been disposed. */
  get isDisposed(): boolean {
    return this.disposed;
  }

  /**
   * Ensures an active session exists and returns it.
   *
   * Serializes concurrent calls so that only one session creation happens
   * at a time. Subsequent callers receive the already-created session.
   *
   * Note: this only serializes session *creation*. To serialize a full
   * critical section that includes `session.prompt()`, use
   * {@link runSerialized} instead — otherwise concurrent calls would issue
   * overlapping `prompt()` invocations on the same session.
   */
  async ensureSession(): Promise<AgentSession> {
    return this.runSerialized((session) => Promise.resolve(session));
  }

  /**
   * Runs an async critical section under the per-session serialization queue.
   *
   * The callback receives a session that is guaranteed to exist for the
   * duration of the section. Concurrent calls to `runSerialized` on the
   * same session execute strictly in arrival order; calls against
   * different sessions (different managers) run in parallel.
   *
   * This is the boundary that makes `session.prompt()` safe under
   * concurrency: both `doGenerate` and `doStream` wrap their
   * subscribe → prompt → resolve cycle in `runSerialized` so a second
   * prompt never starts before the first turn completes.
   *
   * Rejections are swallowed for queue continuity (the queue stays
   * alive), but propagated to the caller.
   */
  runSerialized<T>(
    fn: (session: AgentSession) => Promise<T>,
  ): Promise<T> {
    const task = this.#queueTail.then(async () => {
      if (this.disposed) {
        this.disposed = false; // Reset so a new session can be created
        this.logger.info("Creating new session after dispose()");
      }
      const session = this.session ?? (await this.#createSession());
      return fn(session);
    });

    // Update queue tail — swallow rejections so the queue stays alive
    this.#queueTail = task.then(
      () => {},
      () => {},
    );
    return task;
  }

  /**
   * Invalidates the current session without disposing the underlying Pi session.
   *
   * Used for error recovery — when a session.prompt() fails, we clear the local
   * reference so the next call creates a fresh session automatically.
   * Unlike dispose(), this does not call session.dispose() because the session
   * may already be in a broken state.
   */
  invalidateSession(): void {
    if (this.session) {
      this.logger.info(
        `Invalidating Pi session after error: ${this.sessionId}`,
      );
      this.session = null;
      this.sessionId = undefined;
    }
  }

  /**
   * Disposes the underlying Pi session and releases resources.
   *
   * After calling dispose(), the next ensureSession() call will create a fresh
   * session. Safe to call multiple times. Also removes this manager from the
   * exit-cleanup registry.
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
    PiSessionManager.#activeManagers.delete(this);
  }

  // ─── Private helpers ───

  /**
   * Creates a new Pi agent session with the configured model, tools,
   * sandbox, and custom settings.
   */
  async #createSession(): Promise<AgentSession> {
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

  /**
   * Registers a process exit handler once to dispose all active sessions.
   */
  static #registerExitHandler(): void {
    if (PiSessionManager.#exitHandlerRegistered) return;
    PiSessionManager.#exitHandlerRegistered = true;

    process.on("exit", () => {
      for (const mgr of PiSessionManager.#activeManagers) {
        try {
          mgr.dispose();
        } catch {
          // Best-effort cleanup on exit
        }
      }
    });
  }
}
