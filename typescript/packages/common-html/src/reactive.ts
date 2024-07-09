import { isObject, noOp } from "./util.js";
import { Cancel, isCancel } from "./cancel.js";

/**
 * A reactive value is any type with a `sink()` method that can be used
 * to subscribe to updates.
 * - `sink()` must take a callback function that will be called with the
 *   updated value.
 * - `sink()` must return a `Cancel` function that can be called to unsubscribe.
 */
export type ReactiveValue<T> = {
  sink: (callback: (value: T) => void) => Cancel;
};

export const isReactiveValue = (
  value: unknown
): value is ReactiveValue<unknown> => {
  return isObject(value) && "sink" in value && typeof value.sink === "function";
};

export const effect = (
  value: unknown,
  callback: (value: unknown) => Cancel | void
) => {
  let cleanup: Cancel = noOp;
  if (isReactiveValue(value)) {
    const cancel = value.sink((value: unknown) => {
      cleanup();
      const next = callback(value);
      cleanup = isCancel(next) ? next : noOp;
    });
    return () => {
      cancel();
      cleanup();
    };
  }
  const next = callback(value);
  cleanup = isCancel(next) ? next : noOp;
  return cleanup;
};
