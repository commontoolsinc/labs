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

export const chooseLeft = <T>(left: T, _right: T) => left

type TransactionQueue = {
  name: string,
  transact: () => void
  withTransaction: <T>(
    perform: (value: T) => void,
    value: T,
    choose: (left: T, right: T) => T
  ) => void
}

const createTransactionQueue = (name: string): TransactionQueue => {
  const queue = new Map<(value: any) => void, any>()

  const transact = () => {
    debugLog(name, `transacting ${queue.size} jobs`)
    for (const [perform, value] of queue) {
      perform(value)
    }
    queue.clear()
  }

  /**
   * Queue a job to perform during the next transaction,
   * along with a value to pass to the job
   * @param perform - The function to perform (used as the unique key in
   *  the queue)
   * @param value - The value to pass to the perform function
   * @param choose - A function to choose between two values if more than one
   *  has been set during the transaction (default is chooseLeft)
   */
  const withTransaction = <T>(
    perform: (value: T) => void,
    value: T,
    choose: (left: T, right: T) => T = chooseLeft
  ) => {
    const left = queue.get(perform)
    queue.set(perform, left !== undefined ? choose(left, value) : value)
  }

  return {name, transact, withTransaction}
}

const createTransactionManager = () => {
  const streams = createTransactionQueue('streams')
  const cells = createTransactionQueue('cells')
  const computed = createTransactionQueue('computed')
  const sinks = createTransactionQueue('sinks')

  let isScheduled = false

  const schedule = () => {
    if (isScheduled) {
      return
    }
    debugLog('TransactionManager', `transaction scheduled`)
    isScheduled = true
    queueMicrotask(transact)
  }

  const transact = () => {
    debugLog('TransactionManager', 'transaction start')
    // First perform all event stream updates
    streams.transact()
    // Then perform all cell state updates
    cells.transact()
    // Finally, update sinks
    sinks.transact()
    isScheduled = false
    debugLog('TransactionManager', 'transaction end')
  }

  const withPhase = (
    queue: TransactionQueue
  ) => <T>(
    perform: (value: T) => void,
    value: T,
    choose: (left: T, right: T) => T = chooseLeft
  ) => {
    debugLog(queue.name, 'queue job')
    queue.withTransaction(perform, value, choose)
    schedule()
  }

  const withStreams = withPhase(streams)
  const withCells = withPhase(cells)
  const withComputed = withPhase(computed)
  const withSinks = withPhase(sinks)

  return {withCells, withStreams, withComputed, withSinks}
}

const {
  withCells,
  withStreams,
  withComputed,
  withSinks
} = createTransactionManager()

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

export const createStream = <T>(choose = chooseLeft) => {
  const updatesPublisher = createPublisher<T>()
  const send = (value: T) => withStreams(updatesPublisher.send, value, choose)
  const sink = (subscriber: Subscriber<T>) => updatesPublisher.sink(subscriber)
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
  get(): T
  onChange(subscriber: Subscriber<void>): Cancel
}

export const createCell = <T>(initial: T, name: string) => {
  const dirtyPublisher = createPublisher<void>()
  let state = initial

  const get = () => state
  const getName = () => name

  const setState = (value: T) => {
    // Only notify downstream if state has changed value
    if (!isEqual(state, value)) {
      state = value
      dirtyPublisher.send()
    }
  }

  const send = (value: T) => {
    withCells(setState, value)
  }

  const onChange = (subscriber: Subscriber<void>) => {
    subscriber.send()
    return dirtyPublisher.sink(subscriber)
  }

  return {get, name: getName, send, onChange}
}

export const createComputed = <T>(
  upstreams: Array<CellLike<any>>,
  calc: (...values: Array<any>) => T
) => {
  const dirtyPublisher = createPublisher<void>()

  const recompute = (): T => calc(...upstreams.map(sample))

  let isDirty = false
  let state = recompute()

  // TODO need to actually dispatch to sinks
  // Think about this... when does a computed cell recalculate?
  const markDirty = () => {
    isDirty = true
    dirtyPublisher.send()
  }

  const subject = {
    send: markDirty
  }

  const cancel = combineCancels(upstreams.map(cell => cell.onChange(subject)))

  const get = () => {
    if (isDirty) {
      state = recompute()
      isDirty = false
    }
    return state
  }

  const onChange = (
    subscriber: Subscriber<void>
  ) => {
    subscriber.send()
    dirtyPublisher.sink(subscriber)
  }

  return {get, onChange, cancel}
}

/**
 * "Hold" the latest value from a stream in a cell
 * @param stream - the stream to update cell
 * @param initial - the initial value for the cell
 * @returns cell
 */
export const hold = <T>(stream: Sink<T>, initial: T) => {
  const {get, onChange, send} = createCell(initial, 'hold')
  const cancel = stream.sink({
    send: value => send(value)
  })
  return {get, onChange, cancel}
}

export const createEffect = <T>(
  cell: CellLike<T>,
  receive: (value: T) => void
) => {
  const send = (cell: CellLike<T>) => receive(cell.get())
  cell.onChange({
    send: () => withSinks(send, cell)
  })
}