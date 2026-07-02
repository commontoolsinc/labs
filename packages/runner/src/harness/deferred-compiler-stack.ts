/**
 * Deferred access to the TypeScript compiler stack (see compiler-stack.ts for
 * why it must not load at worker boot).
 *
 * Flows that compile, resolve, or parse source `await ensureCompilerStack()`
 * once at their (async) entry point; the sync code under them reaches values
 * through `compilerStack()`, which throws — loudly, with the fix — when a
 * flow forgot its ensure. Boot-path code must do neither.
 */
import type * as CompilerStackModule from "./compiler-stack.ts";

export type CompilerStack = typeof CompilerStackModule;

let loaded: CompilerStack | undefined;
let loading: Promise<CompilerStack> | undefined;

/** Load (once) the compiler stack; idempotent and cheap when already loaded. */
export function ensureCompilerStack(): Promise<CompilerStack> {
  return loading ??= import("./compiler-stack.ts").then((m) => (loaded = m));
}

/**
 * The loaded compiler stack. Throws when no flow has awaited
 * {@link ensureCompilerStack} yet — a missed ensure on a new flow fails loud
 * here rather than silently re-eagering the compiler into the boot path.
 */
export function compilerStack(): CompilerStack {
  if (loaded === undefined) {
    throw new Error(
      "compiler stack not loaded — this flow must `await ensureCompilerStack()` before parsing/compiling",
    );
  }
  return loaded;
}
