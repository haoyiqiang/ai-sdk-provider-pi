import type { Model, Api, Provider, ModelThinkingLevel as PiThinkingLevel } from '@earendil-works/pi-ai';
import type {
  AuthStorage,
  ModelRegistry,
  SessionManager,
  BashOperations,
  ReadOperations,
  WriteOperations,
  EditOperations,
} from '@earendil-works/pi-coding-agent';

/**
 * Tool operations interfaces are re-exported from the upstream Pi Coding Agent
 * SDK rather than redeclared here, so provider and consumers share a single
 * source of truth for the sandbox tool execution contracts.
 */
export type {
  BashOperations,
  ReadOperations,
  WriteOperations,
  EditOperations,
} from '@earendil-works/pi-coding-agent';

/**
 * Model identifier format for Pi provider.
 * Supports two formats:
 * - Full: "anthropic/claude-sonnet-4" (provider/modelId)
 * - Short: "sonnet" (convenience alias)
 */
export type PiModelId = string;

/**
 * Sandbox execution configuration.
 *
 * Lets consumers choose where the agent's filesystem/bash tools actually run.
 * - `mode: 'local'` (default) uses Pi's built-in local implementations from
 *   `@earendil-works/pi-coding-agent` (e.g. `createLocalBashOperations`).
 * - `mode: 'custom'` uses the operations supplied via `operations`. Any
 *   operation left undefined falls back to the local default, so consumers
 *   only need to override the tools they care about (e.g. proxy only `bash`
 *   to a remote sandbox and keep local `read`/`write`).
 */
export interface SandboxConfig {
  /**
   * Sandbox backend selection.
   * - 'local' (default): use Pi's built-in local shell/filesystem operations.
   * - 'custom': use the operations provided via `operations`, falling back
   *   to local defaults for any tool not supplied.
   */
  mode?: 'local' | 'custom';
  /**
   * Working directory for sandboxed tool execution.
   * Defaults to the model/provider cwd or `process.cwd()`.
   */
  cwd?: string;
  /**
   * Custom tool operations. Only consulted when `mode === 'custom'`.
   * Each undefined tool falls back to its local default implementation.
   */
  operations?: {
    bash?: BashOperations;
    read?: ReadOperations;
    write?: WriteOperations;
    edit?: EditOperations;
  };
}

/**
 * Settings for the Pi provider factory function.
 * These configure authentication, model discovery, and session management.
 */
export interface PiProviderSettings {
  /**
   * Custom AuthStorage instance.
   * If not provided, defaults to AuthStorage.create() using the default agent directory.
   */
  authStorage?: AuthStorage;

  /**
   * Custom ModelRegistry instance.
   * If not provided, defaults to ModelRegistry.create(authStorage).
   */
  modelRegistry?: ModelRegistry;

  /**
   * Custom SessionManager instance.
   * If not provided, defaults to SessionManager.inMemory() for stateless usage.
   */
  sessionManager?: SessionManager;

  /**
   * Working directory for the agent session.
   * @default process.cwd()
   */
  cwd?: string;

  /**
   * Pi agent directory path.
   * @default '~/.pi/agent'
   */
  agentDir?: string;

  /**
   * Tools to allow (whitelist). If not set, all tools are available.
   */
  tools?: string[];

  /**
   * Tools to exclude (blacklist).
   */
  excludeTools?: string[];

  /**
   * Suppress all tools. "all" removes everything, "builtin" keeps only custom tools.
   */
  noTools?: 'all' | 'builtin';

  /**
   * Custom tools to register.
   */
  customTools?: unknown[];

  /**
   * Sandbox execution configuration for the agent's built-in
   * filesystem/bash tools. Lets tools run locally, in a remote sandbox,
   * or via custom operations injected by the consumer. Provider-level
   * default; overridden by model-level `sandbox`.
   */
  sandbox?: SandboxConfig;

  /**
   * Enable verbose logging for debugging.
   */
  verbose?: boolean;

  /**
   * Custom logger for handling warnings and errors.
   * - Set to `false` to disable all logging
   * - Provide a Logger object to use custom logging
   * - Leave undefined to use console (default)
   */
  logger?: Logger | false;
}

/**
 * Settings for individual PiLanguageModel instances.
 * These are per-model settings that override provider-level defaults.
 */
export interface PiLanguageModelSettings {
  /**
   * Thinking level for the model.
   * Controls how much reasoning the model performs.
   * - "off" — No extended thinking
   * - "minimal" — Minimal thinking
   * - "low" — Low thinking
   * - "medium" — Moderate thinking (default)
   * - "high" — Deep reasoning
   * - "xhigh" — Maximum reasoning
   */
  thinkingLevel?: PiThinkingLevel;

  /**
   * Maximum number of agent turns.
   */
  maxTurns?: number;

  /**
   * Custom system prompt to use.
   */
  systemPrompt?: string;

  /**
   * Append additional content to the system prompt.
   */
  appendSystemPrompt?: string;

  /**
   * Working directory for this model instance.
   * Overrides provider-level cwd.
   */
  cwd?: string;

  /**
   * Tools to allow for this model instance.
   * Overrides provider-level tools.
   */
  tools?: string[];

  /**
   * Tools to exclude for this model instance.
   * Overrides provider-level excludeTools.
   */
  excludeTools?: string[];

  /**
   * Maximum budget in USD for the query.
   */
  maxBudgetUsd?: number;

  /**
   * Maximum size (in characters) for tool results sent to the client stream.
   * @default 10000
   */
  maxToolResultSize?: number;

  /**
   * Sandbox execution configuration. Overrides provider-level `sandbox`.
   */
  sandbox?: SandboxConfig;
}

/**
 * Options for the PiLanguageModel constructor.
 */
export interface PiLanguageModelOptions {
  /**
   * The model identifier (e.g., "anthropic/claude-sonnet-4").
   */
  id: PiModelId;

  /**
   * The resolved Pi Model object.
   */
  model: Model<Api>;

  /**
   * Provider-level settings (merged with model-level settings).
   */
  settings: PiLanguageModelSettings;

  /**
   * Provider-level configuration.
   */
  providerSettings: PiProviderSettings;

  /**
   * Validation warnings from settings validation.
   */
  settingsValidationWarnings?: string[];
}

/**
 * Logger interface for custom logging.
 */
export interface Logger {
  debug: (message: string) => void;
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
}

/**
 * Parsed model identifier components.
 */
export interface ParsedModelId {
  provider: Provider;
  modelId: string;
}

/**
 * Internal state for tracking tool execution during streaming.
 */
export interface ToolStreamState {
  toolCallId: string;
  toolName: string;
  args: unknown;
  startTime: number;
  inputAccumulator: string;
  hasEmittedStart: boolean;
}

/**
 * Extended stream part type that includes Pi-specific metadata.
 */
export interface PiProviderMetadata {
  /** Pi session ID */
  sessionId?: string;
  /** Cost in USD */
  costUsd?: number;
  /** Duration in milliseconds */
  durationMs?: number;
  /** Model provider */
  provider?: string;
  /** Model ID */
  modelId?: string;
  /**
   * The actual model ID used by the provider (e.g., 'claude-sonnet-4-20250514').
   * May differ from the requested modelId due to model version resolution.
   */
  responseModel?: string;
  /**
   * Unique identifier for the LLM response, provided by some APIs.
   */
  responseId?: string;
}