import { isDeno } from "./env.ts";

/**
 * A minimal async-context store: read the current value with `getStore()`, and
 * bind a value for the (sync or async) duration of `run`. A thin shared shape
 * over Deno/Node `AsyncLocalStorage` and a promise-aware fallback.
 */
export interface AsyncLocalStore<T> {
  getStore(): T | undefined;
  run<R>(value: T, fn: () => R): R;
}

/**
 * Promise-aware synchronous fallback for runtimes without `AsyncLocalStorage`
 * (e.g. the browser). The previous value is restored in a `.finally` for
 * promise results and synchronously otherwise — so the bound value
 * conservatively spans the whole pending promise.
 */
class FallbackAsyncLocalStore<T> implements AsyncLocalStore<T> {
  #store: T | undefined;

  getStore(): T | undefined {
    return this.#store;
  }

  run<R>(value: T, fn: () => R): R {
    const previous = this.#store;
    this.#store = value;
    try {
      const result = fn();
      if (result instanceof Promise) {
        return result.finally(() => {
          this.#store = previous;
        }) as R;
      }
      this.#store = previous;
      return result;
    } catch (error) {
      this.#store = previous;
      throw error;
    }
  }
}

const AsyncLocalStorageCtor = isDeno()
  ? (await import("node:async_hooks"))
    .AsyncLocalStorage as new <T>() => AsyncLocalStore<T>
  : FallbackAsyncLocalStore;

/**
 * Create an async-context store, backed by Deno/Node `AsyncLocalStorage` when
 * available and a promise-aware synchronous fallback otherwise.
 */
export const createAsyncLocalStore = <T>(): AsyncLocalStore<T> =>
  new AsyncLocalStorageCtor<T>();
