import { debug } from "./shared.js"
import {
  publisher,
  Send,
  Sendable,
  Cancel,
  Cancellable,
  combineCancels
} from "./publisher.js"
import { state, Signal, __updates__ } from "./signal.js"

const __sink__ = Symbol('sink')

/** A sink is an observable that delivers new values */
export type Sink<T> = {
  [__sink__]: (subscriber: Send<T>) => Cancel
}

/** A stream is a sink that can be cancelled */
export type Stream<T> = Sink<T> & Cancellable

/**
 * Subscribe to a stream, receiving all updates after the point of subscription.
 * @return a function to cancel the subscription.
 */
export const sink = <T>(
  upstream: Stream<T>,
  subscriber: Send<T>
) => upstream[__sink__](subscriber)

export type WriteableStream<T> = Sendable<T> & Sink<T>

/**
 * Create a stream subject - a source for a stream that has a send method
 * for publishing new items to stream.
 */
export const subject = <T>(): WriteableStream<T> => {
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

const throttled = (job: () => void) => {
  let isScheduled = false

  const perform = () => {
    isScheduled = false
    job()
  }

  return () => {
    if (!isScheduled) {
      isScheduled = true
      queueMicrotask(perform)
    }
  }
}

export const chooseLeft = <T>(left: T, _: T) => left

/**
 * Join two streams together.
 * Uses throttling/batching on microtask to ensure upstreams that emitted
 * during same tick are processed together during the same moment. E.g.
 * prevents the diamond problem.
 */
export const join = <T>(
  left: Stream<T>,
  right: Stream<T>,
  choose: (left: T, right: T) => T = chooseLeft
) => generate<T>(send => {
  let leftState: T | undefined = undefined
  let rightState: T | undefined = undefined

  // NOTE: we are currently using the microtask queue to batch and solve the
  // diamond problem. This works as long as events in the stream are values.
  // 
  // If we want to support promises as values but maintain this kind of
  // moment-by-moment batching, we will need to create a transaction system
  // with a logical clock that waits for all promises to resolve before moving
  // on to the next transaction.
  const forward = throttled(() => {
    if (leftState !== undefined && rightState !== undefined) {
      const value = choose(leftState, rightState)
      send(value)
    } else if (leftState !== undefined) {
      send(leftState)
    } else if (rightState !== undefined) {
      send(rightState)
    }
    leftState = undefined
    rightState = undefined
  })

  const cancelLeft = sink(left, value => {
    debug('zip', 'queue left value', value)
    leftState = value
    forward()
  })

  const cancelRight = sink(right, value => {
    debug('zip', 'queue right value', value)
    rightState = value
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
  // We track the current reduction state for the scan in a closure variable
  // instead of using the signal state directly. That's because signal state
  // has a last-write-wins semantics. It could skip events while scanning.
  // Tracking the reduction separately and setting it as the signal state
  // after each step ensures we process every event.
  let reduction = initial
  const cancel = sink(upstream, (value: T) => {
    reduction = step(reduction, value)
    send(reduction)
  })
  return { get, [__updates__]: updates, cancel }
}

/** Hold the latest value of a stream in a signal */
export const hold = <T>(
  upstream: Stream<T>,
  initial: T
) => scan(upstream, (_, value) => value, initial)
