import { debug } from "./shared.js"
import { publisher, Send, Cancel, combineCancels } from "./publisher.js"
import { state, Signal, __updates__ } from "./signal.js"

const __sink__ = Symbol('sink')

export type Stream<T> = {
  [__sink__]: (subscriber: Send<T>) => Cancel
  cancel?: Cancel
}

/**
 * Subscribe to a stream, receiving all updates after the point of subscription.
 * @return a function to cancel the subscription.
 */
export const sink = <T>(
  upstream: Stream<T>,
  subscriber: Send<T>
) => upstream[__sink__](subscriber)

/**
 * Create a stream subject - a source for a stream that has a send method
 * for publishing new items to stream.
 */
export const subject = <T>() => {
  const { pub, sub } = publisher<T>()
  return { [__sink__]: sub, send: pub }
}

/**
 * Create a new stream source using a closure to publish new items to stream
 * Closure receives a single argument, a send function to publish new items,
 * and may return a cancel function to stop generation and clean up resources.
 */
export const generate = <T>(
  generate: (send: Send<T>) => Cancel | undefined
): Stream<T> => {
  const { [__sink__]: sink, send } = subject<T>()
  const cancel = generate(send)
  return { [__sink__]: sink, cancel }
}

/** Map a stream of values */
export const map = <T, U>(
  upstream: Stream<T>,
  transform: (value: T) => U
) => generate<U>(send => {
  return sink(upstream, value => send(transform(value)))
})

/** Get a key from an object */
const getKey = <T extends object, U extends keyof T & string>(
  obj: T,
  key: U
) => obj[key];

/** Select a key from an object */
export const select = <T extends object, U extends keyof T & string>(
  upstream: Stream<T>,
  key: U
) => map(upstream, (o: T) => getKey(o, key))

/** Filter a stream of values using a predicate function. */
export const filter = <T>(
  upstream: Stream<T>,
  predicate: (value: T) => boolean
) => generate<T>(send => {
  return sink(upstream, value => {
    if (predicate(value)) {
      send(value)
    }
  })
})

/**
 * Zip two streams together.
 * Will buffer left and right values until both are available.
 */
export const zip = <T, U, V>(
  left: Stream<T>,
  right: Stream<U>,
  combine: (left: T, right: U) => V
) => generate<V>(send => {
  const leftQueue: Array<T> = []
  const rightQueue: Array<U> = []

  const forward = () => {
    if (leftQueue.length > 0 && rightQueue.length > 0) {
      const leftValue = leftQueue.shift()!
      const rightValue = rightQueue.shift()!
      const value = combine(leftValue, rightValue)
      debug('zip', 'dispatching value', value)
      send(value)
    }
  }

  const cancelLeft = sink(left, value => {
    debug('zip', 'queue value', value)
    leftQueue.push(value)
    forward()
  })

  const cancelRight = sink(right, value => {
    debug('zip', 'queue value', value)
    rightQueue.push(value)
    forward()
  })

  return combineCancels([cancelLeft, cancelRight])
})

/** Scan a stream, accumulating step state in a signal */
export const scan = <T, U>(
  upstream: Stream<T>,
  step: (state: U, value: T) => U,
  initial: U
): Signal<U> => {
  const { get, [__updates__]: updates, send } = state(initial)
  const cancel = sink(upstream, (value: T) => {
    send(step(get(), value))
  })
  return { get, [__updates__]: updates, cancel }
}

/** Hold the latest value of a stream in a signal */
export const hold = <T>(
  upstream: Stream<T>,
  initial: T
) => scan(upstream, (_, value) => value, initial)
