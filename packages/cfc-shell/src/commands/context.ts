/**
 * Command execution context for CFC shell commands
 */

import { Label, Labeled, labels } from "../labels.ts";
import { LabeledStream } from "../labeled-stream.ts";
import { VFS } from "../vfs.ts";
import type { PolicyRecord } from "../policy.ts";

/**
 * Environment variable with label and metadata
 */
export interface EnvVar {
  value: string;
  label: Label;
  exported: boolean;
  readonly: boolean;
}

/**
 * Environment - labeled variable store with scope chain
 */
export interface Environment {
  vars: Map<string, EnvVar>;
  get(name: string): Labeled<string> | null;
  set(name: string, value: string, label: Label): void;
  export(name: string): void;
  unset(name: string): void;
  pushScope(): void;
  popScope(): void;
  /** Get all exported vars */
  exported(): Map<string, Labeled<string>>;
  /** Get all vars */
  all(): Map<string, Labeled<string>>;
}

/**
 * Create an environment with optional initial variables
 */
export function createEnvironment(
  initial?: Record<string, { value: string; label: Label }>
): Environment {
  // Scope chain: array of maps, with innermost scope at the end
  const scopes: Map<string, EnvVar>[] = [new Map()];

  // Initialize with provided vars
  if (initial) {
    for (const [name, { value, label }] of Object.entries(initial)) {
      scopes[0].set(name, {
        value,
        label,
        exported: false,
        readonly: false,
      });
    }
  }

  return {
    get vars() {
      return scopes[scopes.length - 1];
    },

    get(name: string): Labeled<string> | null {
      // Search from innermost to outermost
      for (let i = scopes.length - 1; i >= 0; i--) {
        const envVar = scopes[i].get(name);
        if (envVar) {
          return { value: envVar.value, label: envVar.label };
        }
      }
      return null;
    },

    set(name: string, value: string, label: Label): void {
      // Write to innermost scope
      const scope = scopes[scopes.length - 1];
      const existing = scope.get(name);

      if (existing?.readonly) {
        throw new Error(`${name}: readonly variable`);
      }

      scope.set(name, {
        value,
        label,
        exported: existing?.exported ?? false,
        readonly: existing?.readonly ?? false,
      });
    },

    export(name: string): void {
      // Search for the variable and mark it exported
      for (let i = scopes.length - 1; i >= 0; i--) {
        const envVar = scopes[i].get(name);
        if (envVar) {
          envVar.exported = true;
          return;
        }
      }
      // If variable doesn't exist, create it as empty exported var
      scopes[scopes.length - 1].set(name, {
        value: "",
        label: labels.bottom(),
        exported: true,
        readonly: false,
      });
    },

    unset(name: string): void {
      // Remove from innermost scope only
      const scope = scopes[scopes.length - 1];
      const envVar = scope.get(name);

      if (envVar?.readonly) {
        throw new Error(`${name}: readonly variable`);
      }

      scope.delete(name);
    },

    pushScope(): void {
      scopes.push(new Map());
    },

    popScope(): void {
      if (scopes.length > 1) {
        scopes.pop();
      }
    },

    exported(): Map<string, Labeled<string>> {
      const result = new Map<string, Labeled<string>>();

      // Collect all exported vars from all scopes (innermost wins)
      for (let i = scopes.length - 1; i >= 0; i--) {
        for (const [name, envVar] of scopes[i]) {
          if (envVar.exported && !result.has(name)) {
            result.set(name, { value: envVar.value, label: envVar.label });
          }
        }
      }

      return result;
    },

    all(): Map<string, Labeled<string>> {
      const result = new Map<string, Labeled<string>>();

      // Collect all vars from all scopes (innermost wins)
      for (let i = scopes.length - 1; i >= 0; i--) {
        for (const [name, envVar] of scopes[i]) {
          if (!result.has(name)) {
            result.set(name, { value: envVar.value, label: envVar.label });
          }
        }
      }

      return result;
    },
  };
}

/**
 * Callback for requesting user intent at commit points
 */
export type IntentCallback = (action: string, detail: string) => Promise<boolean>;

/**
 * Context passed to command handlers
 */
export interface CommandContext {
  vfs: VFS;
  env: Environment;
  stdin: LabeledStream;
  stdout: LabeledStream;
  stderr: LabeledStream;
  pcLabel: Label;             // current PC taint
  requestIntent: IntentCallback;
  /** Policy records for exchange rule evaluation (e.g., at network boundaries) */
  policies?: PolicyRecord[];
  /** Mock fetch for testing — if set, curl uses this instead of global fetch */
  mockFetch?: (url: string, init?: RequestInit) => Promise<Response>;
}

/**
 * Result of command execution
 */
export interface CommandResult {
  exitCode: number;
  label: Label;  // label of the output produced
  /** If true, the command's output format is structurally fixed (e.g. numbers,
   *  fixed strings) and cannot contain injection regardless of input content.
   *  The interpreter will attest InjectionFree on the output label.
   *  InfluenceClean is preserved as-is (deterministic transform). */
  fixedOutputFormat?: boolean;
}

/**
 * Command function signature
 */
export type CommandFn = (args: string[], ctx: CommandContext) => Promise<CommandResult>;
