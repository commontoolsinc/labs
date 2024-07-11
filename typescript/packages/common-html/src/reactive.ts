import { Cancel, isCancel } from "./cancel.js";

/**
 * A reactive value is any type with a `sink()` method that can be used
 * to subscribe to updates.
 * - `sink()` must take a callback function that will be called with the
 *   updated value.
 * - `sink()` must return a `Cancel` function that can be called to unsubscribe.
 */
export type Reactive<T> = {
  get: () => T;
  sink: (callback: (value: T) => void) => Cancel;
};

export type Named = {
  name: string;
};

export type NamedReactive<T> = Reactive<T> & Named;

export const isReactive = (
  value: unknown
): value is Reactive<unknown> => {
  return typeof (value as Reactive<unknown>)?.sink === "function";
};

export const effect = (
  value: unknown,
  callback: (value: unknown) => Cancel | void
) => {
  if (value == null) {
    return noOp;
  }

  let cleanup: Cancel = noOp;
  if (isReactive(value)) {
    const cancelSink = value.sink((value: unknown) => {
      cleanup();
      const next = callback(value);
      cleanup = isCancel(next) ? next : noOp;
    });
    return () => {
      cancelSink();
      cleanup();
    };
  }

  const maybeCleanup = callback(value);
  return isCancel(maybeCleanup) ? maybeCleanup : noOp;
};

const noOp = () => {};