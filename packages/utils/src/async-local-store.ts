/**
 * A minimal context-store shape: read the current value with `getStore()`, and
 * bind a value while `run` invokes its callback. Native AsyncLocalStorage and
 * the general fallback propagate through promises; the authority-safe
 * synchronous implementation below deliberately does not.
 *
 * This module is intentionally free of top-level `await`: resolving the Deno
 * `AsyncLocalStorage` constructor needs `await import("node:async_hooks")`,
 * which stays at the (runner) call sites. A top-level await in this
 * widely-imported utils module stalls module evaluation in some Deno test
 * graphs ("Module evaluation is still pending after multiple event loop
 * iterations"). Call sites pick the backing class like:
 *
 *     const Storage = (isDeno()
 *       ? (await import("node:async_hooks")).AsyncLocalStorage
 *       : FallbackAsyncLocalStore) as new <T>() => AsyncLocalStore<T>;
 */
export interface AsyncLocalStore<T> {
  getStore(): T | undefined;
  run<R>(value: T, fn: () => R): R;
}

/**
 * Context store for authority-sensitive browser call sites that must never
 * confuse overlapping async chains. The value is available only during the
 * synchronous invocation of `fn`; promise continuations are deliberately
 * unbound. Callers that need true propagation across `await` must use native
 * `AsyncLocalStorage` or thread the value explicitly.
 */
export class SynchronousContextStore<T> implements AsyncLocalStore<T> {
  #store: T | undefined;

  getStore(): T | undefined {
    return this.#store;
  }

  run<R>(value: T, fn: () => R): R {
    const previous = this.#store;
    this.#store = value;
    try {
      return fn();
    } finally {
      this.#store = previous;
    }
  }
}

/**
 * Promise-aware synchronous fallback for runtimes without `AsyncLocalStorage`
 * (e.g. the browser). The previous value is restored in a `.finally` for
 * promise results and synchronously otherwise — so the bound value
 * conservatively spans the whole pending promise.
 */
export class FallbackAsyncLocalStore<T> implements AsyncLocalStore<T> {
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
