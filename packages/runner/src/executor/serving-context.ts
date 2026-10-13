/**
 * Whether the code running now is a serving loop's work, carried per async
 * context. A process that hosts a serving loop beside client runtimes, as
 * `cf test` does on the server-execution arm, reads it to tell the loop's
 * output apart from the clients'.
 *
 * The context is entered where work crosses from one side to the other,
 * since everything else inherits it across its awaits and timers. An
 * `ExecutorHost` enters it for everything the memory server and its owner
 * call it for, the serving runtimes' loopback sessions take each server frame
 * in it, and an emulated client session takes each one outside it. A server
 * frame needs both, because the memory server sends it on a turn armed by
 * whichever session's request caused it. The memory server's own work runs in
 * the context of the session whose request it is handling.
 *
 * The context rides `AsyncLocalStorage` where the host provides it (Deno). A
 * browser has none, and hosts no serving loop; there the promise-aware
 * fallback keeps the context current until a promise run in it settles.
 *
 * This module is a leaf apart from utils: the top-level `await` that picks
 * the store would stall module evaluation inside an import cycle.
 */

import { isDeno } from "@commonfabric/utils/env";
import {
  type AsyncLocalStore,
  FallbackAsyncLocalStore,
} from "@commonfabric/utils/async-local-store";

// Deno/Node `AsyncLocalStorage` when available, the promise-aware fallback
// otherwise. The `await import` stays here (not in the shared utils module): a
// top-level await in widely-imported utils stalls Deno module evaluation.
const ServingContextStorage = (isDeno()
  // deno-lint-ignore cf-imports/no-inline-module-import
  ? (await import("node:async_hooks")).AsyncLocalStorage
  : FallbackAsyncLocalStore) as new <T>() => AsyncLocalStore<T>;

const servingContext = new ServingContextStorage<boolean>();

/** Indicates whether the caller is running a serving loop's work. */
export function inServingContext(): boolean {
  return servingContext.getStore() === true;
}

/**
 * Calls `fn` as a serving loop's work, or with `serving === false` as work
 * outside any serving loop, and returns what it returns.
 */
export function runInServingContext<R>(serving: boolean, fn: () => R): R {
  return servingContext.run(serving, fn);
}
