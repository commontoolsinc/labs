/**
 * Shell Session - top-level state for shell execution
 *
 * Manages:
 * - Environment variables with labels
 * - PC (Program Counter) label tracking for implicit flows
 * - Command registry
 * - VFS and I/O streams
 * - Audit log
 */

import { Label, labels } from "./labels.ts";
import { VFS } from "./vfs.ts";
import { CommandRegistry } from "./commands/registry.ts";
import { defaultConfig, type SandboxedExecConfig } from "./sandbox/config.ts";
import { SandboxedExecutor } from "./sandbox/executor.ts";
import {
  type CommandContext,
  type CommandResult,
  createEnvironment,
  Environment,
  IntentCallback,
} from "./commands/context.ts";

// ============================================================================
// Audit Entry
// ============================================================================

export interface AuditEntry {
  timestamp: number;
  command: string;
  inputLabels: Label[];
  outputLabel: Label;
  pcLabel: Label;
  blocked: boolean;
  reason?: string;
}

// ============================================================================
// Shell Session
// ============================================================================

export interface ShellSession {
  vfs: VFS;
  env: Environment;
  registry: CommandRegistry;
  pcLabel: Label;
  lastExitCode: number;
  lastExitLabel: Label;
  requestIntent: IntentCallback;
  audit: AuditEntry[];
  /** Mock fetch for testing — if set, curl uses this instead of global fetch */
  mockFetch?: (url: string, init?: RequestInit) => Promise<Response>;
  getSandboxExecutor(config?: SandboxedExecConfig): SandboxedExecutor;
  commandNotFoundFallback?: (
    commandName: string,
    args: string[],
    ctx: CommandContext,
  ) => Promise<CommandResult>;

  pushPC(label: Label): void;
  popPC(): void;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
        .join(",")
    }}`;
  }
  return JSON.stringify(value);
}

class ShellSessionImpl implements ShellSession {
  vfs: VFS;
  env: Environment;
  registry: CommandRegistry;
  lastExitCode = 0;
  lastExitLabel: Label;
  requestIntent: IntentCallback;
  audit: AuditEntry[] = [];
  private sandboxExecutors = new Map<string, SandboxedExecutor>();
  commandNotFoundFallback?: (
    commandName: string,
    args: string[],
    ctx: CommandContext,
  ) => Promise<CommandResult>;

  // PC label stack (for implicit flows)
  private pcStack: Label[] = [];

  constructor(
    vfs: VFS,
    env: Environment,
    registry: CommandRegistry,
    requestIntent?: IntentCallback,
  ) {
    this.vfs = vfs;
    this.env = env;
    this.registry = registry;
    this.lastExitLabel = labels.bottom();
    this.requestIntent = requestIntent || (() => Promise.resolve(false));
  }

  get pcLabel(): Label {
    // The effective PC label is the join of all labels on the stack
    if (this.pcStack.length === 0) {
      return labels.bottom();
    }
    return labels.joinAll(this.pcStack);
  }

  pushPC(label: Label): void {
    this.pcStack.push(label);
  }

  popPC(): void {
    if (this.pcStack.length > 0) {
      this.pcStack.pop();
    }
  }

  getSandboxExecutor(
    config: SandboxedExecConfig = defaultConfig,
  ): SandboxedExecutor {
    const key = stableStringify(config);
    const existing = this.sandboxExecutors.get(key);
    if (existing) {
      return existing;
    }

    const executor = new SandboxedExecutor(config);
    this.sandboxExecutors.set(key, executor);
    return executor;
  }
}

// ============================================================================
// Factory
// ============================================================================

export function createSession(options: {
  vfs?: VFS;
  env?: Environment;
  registry: CommandRegistry;
  requestIntent?: IntentCallback;
  commandNotFoundFallback?: (
    commandName: string,
    args: string[],
    ctx: CommandContext,
  ) => Promise<CommandResult>;
}): ShellSession {
  const vfs = options.vfs || new VFS();
  const env = options.env || createEnvironment();
  const registry = options.registry;
  const requestIntent = options.requestIntent;

  const session = new ShellSessionImpl(vfs, env, registry, requestIntent);
  session.commandNotFoundFallback = options.commandNotFoundFallback;
  return session;
}
