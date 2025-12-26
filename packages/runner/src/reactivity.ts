import { Cancel, isCancel, noOp } from "./cancel.ts";

export const Subscribe = Symbol.for("$subscribe");

export type SubscriptionCell<T = unknown> = {
  [Subscribe]: (callback: SubscriptionCallback<T>) => Cancel;
};

export type SubscriptionCallback<T> = (value: T) => Cancel | undefined | void;

// This is mostly to abstract using both `CellHandle` and `Cell` in the
// renderer, with some older tests using the latter.
export function isSubscriptionCell(value: unknown): value is SubscriptionCell {
  return typeof value === "object" && !!value && Subscribe in value &&
    typeof value[Subscribe] === "function";
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
  value: SubscriptionCell<T> | T,
  callback: SubscriptionCallback<T>,
): Cancel => {
  if (isSubscriptionCell(value)) {
    return value[Subscribe](callback);
  } else {
    const cancel = callback(value as T);
    return isCancel(cancel) ? cancel : noOp;
  }
};
