import { Cancel, isCancel, noOp } from "./cancel.ts";
import type { ChangeGroup } from "./storage/interface.ts";

export type SinkableCell<T = unknown> = {
  sink: (
    callback: (value: T) => Cancel | undefined | void,
    options?: { changeGroup?: ChangeGroup },
  ) => Cancel;
};

export function isSinkableCell(value: unknown): value is SinkableCell {
  return typeof value === "object" && !!value && "sink" in value &&
    typeof value.sink === "function";
}

/**
 * Effect that runs a callback when the value changes. The callback is also
 * called immediately. Nested reactive values are flattened out, i.e. all layers
 * are subscribed to and the callback is called on the last level.
 *
 * @param {any} value - The value to observe.
 * @param {function} callback - The callback to run when the value changes.
 * @returns {function} - A function to cancel the effect.
 */
export const effect = <T>(
  value: SinkableCell<T> | T,
  callback: (value: T) => Cancel | undefined | void,
): Cancel => {
  if (isSinkableCell(value)) {
    return value.sink(callback);
  } else {
    const cancel = callback(value as T);
    return isCancel(cancel) ? cancel : noOp;
  }
};
