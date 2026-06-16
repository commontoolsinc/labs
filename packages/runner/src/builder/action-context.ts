import { isDeno } from "@commonfabric/utils/env";
import {
  type AsyncLocalStore,
  FallbackAsyncLocalStore,
} from "@commonfabric/utils/async-local-store";
import { getTopFrame } from "./pattern.ts";

/**
 * Ambient marker for "a runner Action (lift/handler invocation) is currently
 * executing user code" — the window in which minting NEW builder artifacts is
 * forbidden (identity E5, design Phase 4).
 *
 * Builder artifacts must be module-scope declarations: the builder-call-
 * hoisting transformer moves every authored builder call to module scope, the
 * SES verifier enforces that shape, and content-addressed identity
 * (`{ identity, symbol }`) only exists for module-scope artifacts. An
 * artifact minted inside a running action has no identity, no provenance, and
 * (closure-bearing) no serializable body — the legacy registry channel that
 * used to keep such values limping along is gone, so the mint now fails
 * loudly at creation time instead of producing a value that cannot be
 * rehydrated.
 *
 * The window rides `AsyncLocalStorage`, so an ASYNC action's continuations
 * stay covered past its awaits (Codex/cubic P1 on the E5 PR). Module
 * evaluation that interleaves while an action is suspended must stay legal:
 * engine evaluation pushes a frame carrying `sourceLocationContext` and is
 * fully synchronous (no microtask can interleave inside it), so "a module-
 * eval frame is on top" precisely identifies the transformer's module-scope
 * mints — including under the non-Deno fallback store, whose window
 * conservatively spans the whole pending action promise.
 */
// Deno/Node `AsyncLocalStorage` when available, the promise-aware fallback
// otherwise. The `await import` stays here (not in the shared utils module): a
// top-level await in widely-imported utils stalls Deno module evaluation.
const ActionWindowStorage =
  (isDeno()
    ? (await import("node:async_hooks")).AsyncLocalStorage
    : FallbackAsyncLocalStore) as new <T>() => AsyncLocalStore<T>;

const actionWindow = new ActionWindowStorage<true>();

/**
 * Run an action's user code inside the no-minting window. Async results keep
 * the window open across their awaits.
 */
export function runInActionExecution<R>(fn: () => R): R {
  return actionWindow.run(true, fn);
}

/**
 * Throw when called inside a running action: builder artifacts must be
 * defined at module level. Called by the lift/handler mint sites. Mints under
 * a module-evaluation frame (`sourceLocationContext`) are the transformer's
 * legal module-scope output and pass.
 */
export function assertNotInActionExecution(kind: string): void {
  if (
    actionWindow.getStore() === true &&
    getTopFrame()?.sourceLocationContext === undefined
  ) {
    throw new Error(
      `Cannot create a ${kind} inside a running action: define the ${kind} ` +
        `at module level. (If this code came from pattern source, this may ` +
        `be a transformer bug — the transformer is supposed to hoist all ` +
        `builder calls to module scope.)`,
    );
  }
}
