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
import { Environment, IntentCallback, createEnvironment } from "./commands/context.ts";

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

  pushPC(label: Label): void;
  popPC(): void;
}

class ShellSessionImpl implements ShellSession {
  vfs: VFS;
  env: Environment;
  registry: CommandRegistry;
  lastExitCode = 0;
  lastExitLabel: Label;
  requestIntent: IntentCallback;
  audit: AuditEntry[] = [];

  // PC label stack (for implicit flows)
  private pcStack: Label[] = [];

  constructor(
    vfs: VFS,
    env: Environment,
    registry: CommandRegistry,
    requestIntent?: IntentCallback
  ) {
    this.vfs = vfs;
    this.env = env;
    this.registry = registry;
    this.lastExitLabel = labels.bottom();
    this.requestIntent = requestIntent || (async () => false);
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
}

// ============================================================================
// Factory
// ============================================================================

export function createSession(options: {
  vfs?: VFS;
  env?: Environment;
  registry: CommandRegistry;
  requestIntent?: IntentCallback;
}): ShellSession {
  const vfs = options.vfs || new VFS();
  const env = options.env || createEnvironment();
  const registry = options.registry;
  const requestIntent = options.requestIntent;

  return new ShellSessionImpl(vfs, env, registry, requestIntent);
}
