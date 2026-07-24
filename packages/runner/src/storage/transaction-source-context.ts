import { isDeno } from "@commonfabric/utils/env";
import {
  type AsyncLocalStore,
  SynchronousContextStore,
} from "@commonfabric/utils/async-local-store";

const SourceActionStorage =
  (isDeno()
    ? (await import("node:async_hooks")).AsyncLocalStorage
    // A browser has no native async-context primitive. The general fallback
    // conservatively spans a returned promise, but overlapping promises can
    // then observe each other's value. Source-action identity controls claim
    // routing, so ambiguity must fail open as "no ambient action" instead of
    // ever attributing one continuation to another action. Sink release and
    // trackAsyncWork capture the action synchronously; client continuations
    // remain on the ordinary upstream path.
    : SynchronousContextStore) as new <T>() => AsyncLocalStore<T>;

const sourceActionContext = new SourceActionStorage<object>();

/** Bind sink release to its source action. Native server contexts also flow
 * through async builtin continuations; browser continuations fail open. */
export function runWithTransactionSourceAction<R>(
  sourceAction: object | undefined,
  fn: () => R,
): R {
  return sourceAction === undefined
    ? fn()
    : sourceActionContext.run(sourceAction, fn);
}

/** Current unambiguous trusted action lineage, when the runtime can retain it. */
export function getTransactionSourceAction(): object | undefined {
  return sourceActionContext.getStore();
}
