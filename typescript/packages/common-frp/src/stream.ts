import { debug } from "./shared.js"
import {
  publisher,
  Sendable,
  Cancel,
  Cancellable,
  combineCancels
} from "./publisher.js"
import { state, Signal } from "./signal.js"

/** A sink is an observable that delivers new values */
export type Sink<T> = {
  sink: (subscriber: Sendable<T>) => Cancel
}

/** A stream is a sink that can be cancelled */
export type Stream<T> = Sink<T> & Cancellable

/**
 * Subscribe to a stream, receiving all updates after the point of subscription.
 * @return a function to cancel the subscription.
 */
export const sink = <T>(
  upstream: Stream<T>,
  subscriber: Sendable<T>
) => upstream.sink(subscriber)

export type WriteableStream<T> = Sendable<T> & Sink<T>

export type ReadableStream<T> = Sink<T> & Cancellable

/**
 * Box up a signal, making it readonly by exposing only the stream sink
 * and optional cancel
 */
export const readonly = <T>(
  {
    sink,
    cancel = undefined
  }: Sink<T> & Cancellable
): ReadableStream<T> => ({
  sink,
  cancel
})

/**
 * Create a stream subject - a source for a stream that has a send method
 * for publishing new items to stream.
 */
export const subject = <T>(): WriteableStream<T> => {
  const { send, sink } = publisher<T>()
  return { send, sink }
}

/** Map a stream of values */
export const map = <T, U>(
  upstream: Stream<T>,
  transform: (value: T) => U
): ReadableStream<U> => {
  const downstreams = publisher<U>()

  const subscriber = {
    "@type": "map",
    transform,
    downstreams: downstreams[Symbol.iterator],
    send: (value: T) => downstreams.send(transform(value))
  }

  const cancel = sink(upstream, subscriber)

  return {
    sink: downstreams.sink,
    cancel
  }
}

/** Filter a stream of values using a predicate function. */
export const filter = <T>(
  upstream: Stream<T>,
  predicate: (value: T) => boolean
): ReadableStream<T> => {
  const downstreams = publisher<T>()

  const subscriber = {
    "@type": "filter",
    predicate,
    downstreams: downstreams[Symbol.iterator],
    send: (value: T) => {
      if (predicate(value)) {
        downstreams.send(value)
      }
    }
  }

  const cancel = sink(upstream, subscriber)

  return {
    sink: downstreams.sink,
    cancel
  }
}

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
): ReadableStream<T> => {
  const downstreams = publisher<T>()

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
      downstreams.send(value)
    } else if (leftState !== undefined) {
      downstreams.send(leftState)
    } else if (rightState !== undefined) {
      downstreams.send(rightState)
    }
    leftState = undefined
    rightState = undefined
  })

  const leftSubscriber = {
    "@type": "join",
    side: "left",
    choose,
    downstreams: downstreams[Symbol.iterator],
    send: (value: T) => {
      debug('join', 'set left value', value)
      leftState = value
      forward()
    }
  }

  const cancelLeft = sink(left, leftSubscriber)

  const rightSubscriber = {
    "@type": "join",
    side: "left",
    choose,
    downstreams: downstreams[Symbol.iterator],
    send: (value: T) => {
      debug('join', 'set right value', value)
      rightState = value
      forward()
    }
  }

  const cancelRight = sink(right, rightSubscriber)

  const cancel = combineCancels([cancelLeft, cancelRight])

  return {
    sink: downstreams.sink,
    cancel
  }
}

/** Scan a stream, accumulating step state in a signal */
export const scan = <T, U>(
  upstream: Stream<T>,
  step: (state: U, value: T) => U,
  initial: U
): Signal<U> => {
  const downstreams = publisher<U>()
  const { get, updates, send } = state(initial)

  // We track the current reduction state for the scan in a closure variable
  // instead of using the signal state directly. That's because signal state
  // has a last-write-wins semantics. It could skip events while scanning.
  // Tracking the reduction separately and setting it as the signal state
  // after each step ensures we process every event.
  let reduction = initial

  const subscriber = {
    "@type": "scan",
    step,
    initial,
    downstreams: downstreams[Symbol.iterator],
    send: (value: T) => {
      reduction = step(reduction, value)
      send(reduction)
    }
  }

  const cancel = sink(upstream, subscriber)

  return { get, updates, cancel }
}

/** Hold the latest value of a stream in a signal */
export const hold = <T>(
  upstream: Stream<T>,
  initial: T
) => scan(upstream, (_, value) => value, initial)
