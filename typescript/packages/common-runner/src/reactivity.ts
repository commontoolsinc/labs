import { Cancel, isCancel, noOp } from "./cancel.js";
import { Cell, isCell } from "./cell.js";
import { DocImpl, isDoc } from "./doc.js";

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
  value: Cell<T> | DocImpl<T> | T,
  callback: (value: T) => Cancel | undefined | void,
): Cancel => {
  if (isDoc(value)) value = value.asCell();

  if (isCell(value) || isDoc(value)) {
    return value.sink(callback);
  } else {
    const cancel = callback(value as T);
    return isCancel(cancel) ? cancel : noOp;
  }
};
