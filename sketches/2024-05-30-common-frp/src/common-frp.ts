/*
TODO: beginnings of a push-pull FRP system using transactions.
This will enable graph cycles.
*/
export const config = {
  debug: false
}

const debugLog = (tag: string, msg: string) => {
  if (config.debug) {
    console.debug(`[${tag}] ${msg}`)
  }
}

const createTransactionManager = () => {
  const streams = new Map<(value: any) => void, any>()
  const cells = new Map<(value: any) => void, any>()
  const sinks = new Set<() => void>()

  let isScheduled = false

  const schedule = () => {
    if (isScheduled) {
      return
    }
    debugLog('TransactionManager.schedule', `transaction scheduled`)
    isScheduled = true
    queueMicrotask(transact)
  }

  const transact = () => {
    debugLog('TransactionManager.transact', 'transaction start')
    // First perform all stream updates.
    debugLog('TransactionManager.transact', `transact streams`)
    for (const [job, value] of streams) {
      job(value)
    }
    // First perform all cell state changes.
    // - Update cell state
    // - Mark computed dirty
    debugLog('TransactionManager.transact', `transact cells`)
    for (const [job, value] of cells) {
      job(value)
    }
    cells.clear()
    // Then perform all cell state reads
    // - Read cell state
    // - Recompute computed cells and mark clean
    debugLog('TransactionManager.transact', `transact sinks`)
    for (const job of sinks) {
      job()
    }
    sinks.clear()
    isScheduled = false
    debugLog('TransactionManager.transact', 'transaction end')
  }

  const withStreams = <T>(job: (value: T) => void, value: T) => {
    debugLog('TransactionManager.withStreams', `queue job with value ${value}`)
    streams.set(job, value)
    schedule()
  }

  const withCells = <T>(job: (value: T) => void, value: T) => {
    debugLog('TransactionManager.withCells', `queue job with value ${value}`)
    cells.set(job, value)
    schedule()
  }

  const withSinks =(job: () => void) => {
    debugLog('TransactionManager.withSinks', `queue job`)
    sinks.add(job)
    schedule()
  }

  return {withStreams, withCells, withSinks}
}

const {withStreams, withCells, withSinks} = createTransactionManager()

export type Unsubscribe = () => void

export type Subscriber<T> = (value: T) => void

/** Low-level pub-sub channel used under the hood by cells and sinks. */
const createPublisher = <T>() => {
  const subscribers = new Set<Subscriber<T>>()

  const pub = (value: T) => {
    debugLog('pub', `dispatching ${value} to ${subscribers.size} subscribers`)
    for (const subscriber of subscribers) {
      subscriber(value)
    }
  }
  
  /**
   * Subscribe to this publisher
   * @param subscriber the function to call when a new value is published
   * @returns Unsubscribe function
   */
  const sub = (subscriber: Subscriber<T>): Unsubscribe => {
    debugLog('sub', 'subscribing')
    subscribers.add(subscriber)
    return () => {
      debugLog('sub', 'canceling subscription')
      subscribers.delete(subscriber)
    }
  }

  return {pub, sub}
}

/** Combine multiple unsubscribe functions into a single unsubscribe function */
export const combineUnsubscribes = (
  unsubscribes: Array<Unsubscribe>
): Unsubscribe => () => {
  for (const cancel of unsubscribes) {
    cancel()
  }
}

/** Symbol for updates subscribe method */
const __updates__ = Symbol('updates')

export type Updates<T> = {
  [__updates__]: (subscriber: Subscriber<T>) => Unsubscribe
}

export type Sink<T> = {
  sink: (subscriber: Subscriber<T>) => Unsubscribe
}

export type Subject<T> = {
  send: (value: T) => void
}

export type Unsubscribable = {
  unsubscribe?: Unsubscribe
}

export type ReadStream<T> = Sink<T> & Updates<T> & Unsubscribable

export type ReadWriteStream<T> = Sink<T> & Updates<T> & Subject<T>

export const createStream = <T>(): ReadWriteStream<T> => {
  const updates = createPublisher<T>()

  const perform = (value: T) => {
    debugLog(`stream`, `value: ${value}`)
    updates.pub(value)
  }

  const send = (value: T) => withStreams(perform, value)

  const sink = (subscriber: Subscriber<T>) => updates.sub(
    (value: T) => withSinks(() => subscriber(value))
  )

  return {send, [__updates__]: updates.sub, sink}
}

export const generateStream = <T>(
  generate: (send: (value: T) => void) => Unsubscribe|undefined
): ReadStream<T> => {
  const {send, [__updates__]: updates, sink} = createStream<T>()
  const unsubscribe = generate(send)
  return {[__updates__]: updates, sink, unsubscribe}
}

export const mapStream = <T, U>(
  stream: ReadStream<T>,
  transform: (value: T) => U
) => generateStream((send: (value: U) => void) => {
  const subscribe = (value: T) => send(transform(value))
  return stream[__updates__](subscribe)
})

export const filterStream = <T>(
  stream: ReadStream<T>,
  predicate: (value: T) => boolean
) => generateStream<T>(send => {
  const subscribe = (value: T) => {
    if (predicate(value)) {
      send(value)
    }
  }
  return stream[__updates__](subscribe)
})

const isEqual = Object.is

export type Gettable<T> = {
  get(): T
}

const sample = <T>(container: Gettable<T>) => container.get()

export type ReadCell<T> = Gettable<T> & Updates<void> & Sink<T> & Unsubscribable
export type ReadWriteCell<T> = Gettable<T> & Updates<void> & Sink<T>

export const createCell = <T>(initial: T) => {
  const updates = createPublisher<void>()

  let state = initial

  const get = () => state

  const performUpdate = (value: T) => {
    // Only perform update if state has actually changed
    if (!isEqual(state, value)) {
      state = value
      debugLog(`cell`, `value: ${state}`)
      updates.pub()
    }
  }

  const send = (value: T) => withCells(performUpdate, value)

  const sink = (subscriber: Subscriber<T>) => {
    const job = () => subscriber(get())
    job()
    return updates.sub(() => withSinks(job))
  }

  return {
    get,
    send,
    [__updates__]: updates.sub,
    sink
  }
}

export type createComputed = {
  <A, B, Z>(
    upstreams: [ReadCell<A>, ReadCell<B>],
    compute: (a: A, b: B) => Z
  ): ReadCell<Z>
  <A, B, C, Z>(
    upstreams: [ReadCell<A>, ReadCell<B>, ReadCell<C>],
    compute: (a: A, b: B, c: C) => Z
  ): ReadCell<Z>
  <A, B, C, D, Z>(
    upstreams: [ReadCell<A>, ReadCell<B>, ReadCell<C>, ReadCell<D>],
    compute: (a: A, b: B, c: C, d: D) => Z
  ): ReadCell<Z>
  <A, B, C, D, E, Z>(
    upstreams: [
      ReadCell<A>,
      ReadCell<B>,
      ReadCell<C>,
      ReadCell<D>,
      ReadCell<E>],
    compute: (a: A, b: B, c: C, d: D, e: E) => Z
  ): ReadCell<Z>
  <A, B, C, D, E, F, Z>(
    upstreams: [
      ReadCell<A>,
      ReadCell<B>,
      ReadCell<C>,
      ReadCell<D>,
      ReadCell<E>,
      ReadCell<F>
    ],
    compute: (a: A, b: B, c: C, d: D, e: E, f: F) => Z
  ): ReadCell<Z>
  <A, B, C, D, E, F, G, Z>(
    upstreams: [
      ReadCell<A>,
      ReadCell<B>,
      ReadCell<C>,
      ReadCell<D>,
      ReadCell<E>,
      ReadCell<F>,
      ReadCell<G>
    ],
    compute: (a: A, b: B, c: C, d: D, e: E, f: F, g: G) => Z
  ): ReadCell<Z>
  <A, B, C, D, E, F, G, H, Z>(
    upstreams: [
      ReadCell<A>,
      ReadCell<B>,
      ReadCell<C>,
      ReadCell<D>,
      ReadCell<E>,
      ReadCell<F>,
      ReadCell<G>,
      ReadCell<H>
    ],
    compute: (a: A, b: B, c: C, d: D, e: E, f: F, g: G, h: H) => Z
  ): ReadCell<Z>
}

export const createComputed: createComputed = (
  upstreams: Array<ReadCell<any>>,
  compute: (...values: Array<any>) => any
): ReadCell<any> => {
  const updates = createPublisher<void>()

  const recompute = () => compute(...upstreams.map(sample))

  let isDirty = false
  let state = recompute()

  const performUpdate = () => {
    debugLog(`computed`, `mark dirty`)
    isDirty = true
    updates.pub()
  }

  const unsubscribe = combineUnsubscribes(
    upstreams.map(cell => cell[__updates__](performUpdate))
  )

  const get = () => {
    if (isDirty) {
      state = recompute()
      debugLog(`computed`, `recomputed state: ${state}`)
      isDirty = false
    }
    return state
  }

  const sink = (subscriber: Subscriber<any>) => {
    const job = () => subscriber(get())
    job()
    return updates.sub(() => withSinks(job))
  }

  return {
    get,
    [__updates__]: updates.sub,
    sink,
    unsubscribe: unsubscribe
  }
}

/**
 * Scan a stream producing a cell that contains the reductions of each step
 * of the reduce operation.
 */
export const scan = <T, U>(
  stream: ReadStream<T>,
  step: (state: U, value: T) => U,
  initial: U
): ReadCell<U> => {
  const {get, [__updates__]: updates, sink, send} = createCell(initial)
  const unsubscribe = stream[__updates__]((value: T) => {
    send(step(get(), value))
  })
  return {get, [__updates__]: updates, sink, unsubscribe}
}

/**
 * Hold the latest value from a stream in a cell.
 */
export const hold = <T>(
  stream: ReadStream<T>,
  initial: T
) => scan(stream, (_, value) => value, initial)