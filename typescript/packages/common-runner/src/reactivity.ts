import { Cancel, isCancel } from "./cancel.js";

export interface ReactiveCell<T> {
  sink(callback: (value: T) => void): () => void;
}

export interface GettableCell<T> {
  get(): T;
}

export interface SendableCell<T> {
  send(value: T): void;
}

/**
 * Check if value is a reactive cell.
 *
 * @param {any} value - The value to check.
 * @returns {boolean}
 */
export const isReactive = <T = unknown>(
  value: ReactiveCell<T> | T,
): value is ReactiveCell<T> => {
  return (
    typeof value === "object" &&
    value !== null &&
    "sink" in value &&
    typeof value.sink === "function"
  );
};

/**
 * Check if value is a gettable cell.
 *
 * @param {any} value - The value to check.
 * @returns {boolean}
 */
export const isGettable = <T = unknown>(
  value: unknown,
): value is GettableCell<T> => {
  return (
    typeof value === "object" &&
    value !== null &&
    "get" in value &&
    typeof value.get === "function"
  );
};

/**
 * Check if value is a sendable cell.
 *
 * @param {any} value - The value to check.
 * @returns {boolean}
 */
export const isSendable = <T = unknown>(
  value: unknown,
): value is SendableCell<T> => {
  return (
    typeof value === "object" &&
    value !== null &&
    "send" in value &&
    typeof value.send === "function"
  );
};

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
  value: ReactiveCell<T> | T,
  callback: (value: T) => Cancel | void,
): Cancel => {
  const listener = () => {
    let cleanup: Cancel = noOp;
    return (value: ReactiveCell<T> | T) => {
      cleanup();
      const next = isReactive(value) ? value.sink(listener()) : callback(value);
      cleanup = isCancel(next) ? next : noOp;
      return next;
    };
  };

  const next = listener()(value);
  return isCancel(next) ? next : noOp;
};

const noOp = () => {};
