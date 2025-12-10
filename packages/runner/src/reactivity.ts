import { Cancel, isCancel, noOp } from "./cancel.ts";

export type SinkableCell<T = unknown> = {
  sink: (callback: (value: T) => Cancel | undefined | void) => Cancel;
};

function isSinkableCell(value: unknown): value is SinkableCell {
  return typeof value === "object" && !!value && "sink" in value &&
    typeof value.sink === "function";
}

/**
 * Effect that runs a callback when the value changes. The callback is also
 * called immediately. Nested reactive values are flattened out, i.e. all layers
 * are subscribed to and the callback is called on the last level.
 *
 * This function uses isCellLike() for duck-typing, allowing CellProxy and other
 * cell-like objects (not just CellImpl instances) to work with the effect system.
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
