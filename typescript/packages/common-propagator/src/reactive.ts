import { isObject } from "./contract.js";
import { Cancel, isCancel } from "./cancel.js";

/**
 * A reactive value is any type with a `sink()` method that can be used
 * to subscribe to updates.
 * - `sink()` must take a callback function that will be called with the
 *   updated value.
 * - `sink()` must return a `Cancel` function that can be called to unsubscribe.
 */
export type Reactive<T> = {
  sink: (callback: (value: T) => void) => Cancel;
};

export const isReactive = (value: unknown): value is Reactive<unknown> => {
  return isObject(value) && "sink" in value && typeof value.sink === "function";
};

/** A gettable is any type implementing a `get()` method */
export type Gettable<T> = {
  get(): T;
};

export const isGettable = (value: unknown): value is Gettable<unknown> => {
  return isObject(value) && "get" in value && typeof value.get === "function";
};

/** A sendable is any type implementing a `send` method */
export type Sendable<T> = {
  send: (value: T) => void;
};

export const isSendable = (value: unknown): value is Sendable<unknown> => {
  return isObject(value) && "send" in value && typeof value.send === "function";
};

export const effect = (
  value: unknown,
  callback: (value: unknown) => Cancel | void,
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

/** Wrap an effect function so that it batches on microtask */
const batcher = (queue = queueMicrotask) => {
  let isScheduled = false;
  let scheduledJob = () => {};

  const perform = () => {
    isScheduled = false;
    scheduledJob();
  };

  return (job: () => void) => {
    scheduledJob = job;
    if (!isScheduled) {
      isScheduled = true;
      queue(perform);
    }
  };
};

/** Batch effects on microtask */
export const render = (
  value: unknown,
  callback: (value: unknown) => Cancel | void,
) => {
  if (value == null) {
    return noOp;
  }

  const queueRender = batcher();

  let cleanup: Cancel = noOp;
  if (isReactive(value)) {
    const cancelSink = value.sink((value: unknown) => {
      queueRender(() => {
        cleanup();
        const next = callback(value);
        cleanup = isCancel(next) ? next : noOp;
      });
    });
    return () => {
      cancelSink();
      cleanup();
    };
  }
  const maybeCleanup = callback(value);
  return isCancel(maybeCleanup) ? maybeCleanup : noOp;
};
