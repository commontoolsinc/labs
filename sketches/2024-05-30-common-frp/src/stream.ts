import { debug } from "./shared"
import { createPublisher, Send, Cancel, combineCancels } from "./publisher"
import { createSignal as createSignal, Signal, __updates__ } from "./signal"

export type Stream<T> = {
  sink: (subscriber: Send<T>) => Cancel
  cancel?: Cancel
}

export const createStream = <T>(
  generate: (send: Send<T>) => Cancel|undefined
): Stream<T> => {
  const {pub, sub: sink} = createPublisher<T>()
  const cancel = generate(pub)
  return {sink, cancel}
}

export const map = <T, U>(
  stream: Stream<T>,
  transform: (value: T) => U
) => createStream<U>(send => {
  return stream.sink((value: T) => send(transform(value)))
})

export const filter = <T>(
  stream: Stream<T>,
  predicate: (value: T) => boolean
) => createStream<T>(send => {
  return stream.sink(value => {
    if (predicate(value)) {
      send(value)
    }
  })
})

export const zip = <T, U, V>(
  left: Stream<T>,
  right: Stream<U>,
  combine: (left: T, right: U) => V
) => createStream<V>(send => {
  const leftQueue: Array<T> = []
  const rightQueue: Array<U> = []

  const forward = () => {
    if (leftQueue.length > 0 && rightQueue.length > 0) {
      const leftValue = leftQueue.shift()!
      const rightValue = rightQueue.shift()!
      const value = combine(leftValue, rightValue)
      debug('join', `dispatching value: ${value} from ${leftValue} and ${rightValue}`)
      send(value)
    }
  }

  const cancelLeft = left.sink(value => {
    leftQueue.push(value)
    forward()
  })

  const cancelRight = right.sink(value => {
    rightQueue.push(value)
    forward()
  })

  return combineCancels([cancelLeft, cancelRight])
})

/**
 * Scan a stream producing a cell that contains the reductions of each step
 * of the reduce operation.
 */
export const scan = <T, U>(
  stream: Stream<T>,
  step: (state: U, value: T) => U,
  initial: U
): Signal<U> => {
  const {get, [__updates__]: updates, sink, send} = createSignal(initial)
  const unsubscribe = stream.sink((value: T) => {
    send(step(get(), value))
  })
  return {get, [__updates__]: updates, sink, unsubscribe}
}

/**
 * Hold the latest value from a stream in a cell.
 */
export const hold = <T>(
  stream: Stream<T>,
  initial: T
) => scan(stream, (_, value) => value, initial)