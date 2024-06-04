export const config = {
  debug: false
}

const debugLog = (tag: string, msg: string) => {
  if (config.debug) {
    console.debug(`[${tag}] ${msg}`)
  }
}

export const batched = <T>(perform: (value: T) => void) => {
  let isScheduled = false
  let state: T | undefined = undefined
  const schedule = (value: T) => {
    state = value
    if (!isScheduled) {
      isScheduled = true
      queueMicrotask(() => {
        debugLog('batched', `performing ${state}`)
        perform(state!)
        isScheduled = false
      })
    }
  }
  return schedule
}

export type Cancel = () => void

export type Subscriber<T> = {
  send: (value: T) => void
}

export type Sink<T> = {
  sink: (subscriber: Subscriber<T>) => Cancel
}

/**
 * Create one-to-many event broadcast channel for a list of subscribers.
 * This is a low-level helper that publishes *synchronously* to all subscribers.
 * We use this to implement higher-level abstractions like streams and cells,
 * which dispatch using a shared transaction system.
 */
export const createPublisher = <T>() => {
  const subscribers = new Set<Subscriber<T>>()

  /** Get subscribers */
  const subs = () => subscribers.values()

  const send = (value: T) => {
    debugLog('publisher', `dispatching ${value} to ${subscribers.size} subscribers`)
    for (const subscriber of subscribers) {
      subscriber.send(value)
    }
  }

  const sink = (subscriber: Subscriber<T>): Cancel => {
    subscribers.add(subscriber)
    return () => subscribers.delete(subscriber)
  }

  return {send, sink, subs}
}

export const combineCancels = (cancels: Array<Cancel>): Cancel => () => {
  for (const cancel of cancels) {
    cancel()
  }
}

export const createStream = <T>() => {
  const updatesPublisher = createPublisher<T>()
  const send = batched((value: T) => {
    debugLog('stream', `sending ${value}`)
    updatesPublisher.send(value)
  })
  const sink = updatesPublisher.sink
  return {name, send, sink}
}

const noOp = () => {}

/**
 * Generate a stream using a callback.
 * Returns a read-only stream.
 */
export const generateStream = <T>(
  produce: (send: (value: T) => void) => Cancel|void
) => {
  const {send, sink} = createStream<T>()
  const cancel = produce(send) ?? noOp
  return {cancel, sink}
}

export const mapStream = <T, U>(
  upstream: Sink<T>,
  transform: (value: T) => U
) => generateStream((send: (value: U) => void) => {
  return upstream.sink({
    send: value => send(transform(value))
  })
})

export const filterStream = <T>(
  upstream: Sink<T>,
  predicate: (value: T) => boolean
) => generateStream(send => {
  return upstream.sink({
    send: value => {
      if (predicate(value)) {
        send(value)
      }
    }
  })
})

const isEqual = Object.is

export type Gettable<T> = {
  get(): T
}

export const sample = <T>(container: Gettable<T>) => container.get()

export type CellLike<T> = {
  get: () => T
  sink(subscriber: Subscriber<T>): Cancel
}

export const createCell = <T>(initial: T, name: string) => {
  const publisher = createPublisher<T>()
  let state = initial

  const get = () => state

  const send = batched((value: T) => {
    // Only notify downstream if state has changed value
    if (!isEqual(state, value)) {
      state = value
      debugLog('cell', `updated ${state}`)
      publisher.send(state)
    }
  })

  const sink = (subscriber: Subscriber<T>) => {
    subscriber.send(state)
    return publisher.sink(subscriber)
  }

  return {name, get, send, sink}
}

export const createComputed = <T>(
  upstreams: Array<CellLike<any>>,
  compute: (...values: Array<any>) => T
) => {
  const publisher = createPublisher<T>()

  const recompute = (): T => compute(...upstreams.map(sample))

  let state = recompute()

  const get = () => state

  const subject = {
    send: batched(_value => {
      state = recompute()
      debugLog('computed', `recomputed ${state}`)
      publisher.send(state)
    })
  }

  const cancel = combineCancels(upstreams.map(cell => cell.sink(subject)))

  const sink = (
    subscriber: Subscriber<T>
  ) => {
    subscriber.send(state)
    return publisher.sink(subscriber)
  }

  return {get, sink, cancel}
}

/**
 * "Hold" the latest value from a stream in a cell
 * @param stream - the stream to update cell
 * @param initial - the initial value for the cell
 * @returns cell
 */
export const hold = <T>(stream: Sink<T>, initial: T, name: string) => {
  const cell = createCell(initial, name)
  const cancel = stream.sink(cell)
  return {get: cell.get, sink: cell.sink, cancel}
}
