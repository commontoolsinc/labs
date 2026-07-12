import { isDeno } from "@commonfabric/utils/env";
import {
  type AsyncLocalStore,
  FallbackAsyncLocalStore,
} from "@commonfabric/utils/async-local-store";

const SourceActionStorage =
  (isDeno()
    ? (await import("node:async_hooks")).AsyncLocalStorage
    : FallbackAsyncLocalStore) as new <T>() => AsyncLocalStore<T>;

const sourceActionContext = new SourceActionStorage<object>();

/** Bind async builtin continuations to the action that released their sink. */
export function runWithTransactionSourceAction<R>(
  sourceAction: object | undefined,
  fn: () => R,
): R {
  return sourceAction === undefined
    ? fn()
    : sourceActionContext.run(sourceAction, fn);
}

/** Current trusted action lineage, if this async chain came from an action. */
export function getTransactionSourceAction(): object | undefined {
  return sourceActionContext.getStore();
}
