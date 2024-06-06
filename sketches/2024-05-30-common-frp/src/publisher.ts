import { debug } from "./shared"

export type Cancel = () => void

export type Cancellable = {
  cancel?: Cancel
}

export type Send<T> = (value: T) => void

/** Low-level pub-sub channel used under the hood by cells and sinks. */
export const publisher = <T>() => {
  const subscribers = new Set<Send<T>>()

  const pub = (value: T) => {
    for (const subscriber of subscribers) {
      subscriber(value)
    }
  }
  
  /**
   * Subscribe to this publisher
   * @param subscriber the function to call when a new value is published
   * @returns Unsubscribe function
   */
  const sub = (subscriber: Send<T>): Cancel => {
    debug('sub', 'subscribing')
    subscribers.add(subscriber)
    return () => {
      debug('sub', 'canceling subscription')
      subscribers.delete(subscriber)
    }
  }

  return {pub, sub}
}

/** Combine multiple unsubscribe functions into a single unsubscribe function */
export const combineCancels = (
  unsubscribes: Array<Cancel>
): Cancel => () => {
  for (const cancel of unsubscribes) {
    cancel()
  }
}
