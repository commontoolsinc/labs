import { debug } from "./shared.js"

export type Cancel = () => void

export type Cancellable = {
  cancel?: Cancel
}

export type Send<T> = (value: T) => void

/** A sendable is a type that can receive values via a send method */
export type Sendable<T> = {
  send: Send<T>
}

/** Check if a value is sendable */
export const isSendable = <T>(value: any): value is Sendable<T> => {
  return value && typeof value.send === "function"
}

export type Publisher<T> = {
  [Symbol.iterator]: () => Iterator<Sendable<T>>;
  send: (value: T) => void;
  sink: (subscriber: Sendable<T>) => Cancel;
}

/** Low-level pub-sub channel used under the hood. */
export const publisher = <T>(): Publisher<T> => {
  const subscribers = new Set<Sendable<T>>()

  const send = (value: T) => {
    for (const subscriber of subscribers) {
      subscriber.send(value)
    }
  }

  /**
   * Subscribe to this publisher
   * @param subscriber the function to call when a new value is published
   * @returns Unsubscribe function
   */
  const sink = (subscriber: Sendable<T>): Cancel => {
    debug('sub', 'subscribing', subscriber)
    subscribers.add(subscriber)
    return () => {
      debug('sub', 'canceling subscription', subscriber)
      subscribers.delete(subscriber)
    }
  }

  return {
    // Allow iterating over subscribers
    [Symbol.iterator]: () => subscribers.values(),
    send,
    sink
  }
}

/** Combine multiple unsubscribe functions into a single unsubscribe function */
export const combineCancels = (
  unsubscribes: Array<Cancel>
): Cancel => () => {
  for (const cancel of unsubscribes) {
    cancel()
  }
}
