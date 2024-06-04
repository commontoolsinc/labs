export const config = {
  debug: false
}

const debugLog = (tag: string, msg: string) => {
  if (config.debug) {
    console.debug(`[${tag}] ${msg}`)
  }
}

let _cidCounter = 0

/** Create a lifetime-unique client ID, based on incrementing a counter */
const cid = () => `cid${_cidCounter++}`

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

export type Subject<T> = {
  send: (value: T) => void
}

export type Sink<T> = {
  sink: (subscriber: Subject<T>) => Cancel
}

const pub = <T>(subscribers: Set<Subject<T>>, value: T) => {
  debugLog('pub', `dispatching value ${value} to ${subscribers.size} subscribers`)
  for (const subscriber of subscribers) {
    subscriber.send(value)
  }
}

const sub = <T>(
  subscribers: Set<Subject<T>>,
  subscriber: Subject<T>
) => {
  debugLog('sub', 'subscribing')
  subscribers.add(subscriber)
  return () => {
    debugLog('sub', 'canceling subscription')
    subscribers.delete(subscriber)
  }
}

export const combineCancels = (cancels: Array<Cancel>): Cancel => () => {
  for (const cancel of cancels) {
    cancel()
  }
}

export const createStream = <T>() => {
  const id = cid()
  const downstreams = new Set<Subject<T>>()

  const send = batched((value: T) => {
    debugLog(`stream ${id}`, `sending ${value}`)
    pub(downstreams, value)
  })

  const sink = (subscriber: Subject<T>) => sub(downstreams, subscriber)

  return {send, sink}
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
) => {
  const transformed = createStream<U>()

  const cancel = upstream.sink({
    send: value => transformed.send(transform(value))
  })

  return {cancel, sink: transformed.sink}
}

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

export const createCell = <T>(initial: T) => {
  const id = cid()
  const downstreams = new Set<Subject<T>>()
  let state = initial

  const get = () => state

  const send = batched((value: T) => {
    // Only notify downstream if state has changed value
    if (!isEqual(state, value)) {
      state = value
      debugLog(`cell ${id}`, `updated ${state}`)
      pub(downstreams, state)
    }
  })

  const sink = (subscriber: Subject<T>) => {
    subscriber.send(state)
    return sub(downstreams, subscriber)
  }

  return {get, send, sink}
}

export type CellLike<T> = {
  get: () => T
  sink: (subscriber: Subject<T>) => Cancel
}

export const createComputed = <T>(
  upstreams: Array<CellLike<any>>,
  compute: (...values: Array<any>) => T
) => {
  const id = cid()
  const downstreams = new Set<Subject<T>>()

  const recompute = (): T => compute(...upstreams.map(sample))

  let state = recompute()

  const get = () => state

  const subject = {
    send: batched(_ => {
      state = recompute()
      debugLog(`computed ${id}`, `recomputed ${state}`)
      pub(downstreams, state)
    })
  }

  const cancel = combineCancels(upstreams.map(cell => cell.sink(subject)))

  const sink = (
    subscriber: Subject<T>
  ) => {
    subscriber.send(state)
    return sub(downstreams, subscriber)
  }

  return {get, sink, cancel}
}

/**
 * "Hold" the latest value from a stream in a cell
 * @param stream - the stream to update cell
 * @param initial - the initial value for the cell
 * @returns cell
 */
export const hold = <T>(
  stream: Sink<T>,
  initial: T
) => {
  const cell = createCell(initial)
  const cancel = stream.sink(cell)
  return {get: cell.get, sink: cell.sink, cancel}
}
