export const config = {
  debug: false
}

const debugLog = (tag: string, msg: string) => {
  if (config.debug) {
    console.debug(`[${tag}] ${msg}`)
  }
}

export const chooseLeft = <T>(left: T, _right: T) => left

const TransactionQueue = (name: string) => {
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

  return {transact, withTransaction}
}

const TransactionManager = () => {
  const streamQueue = TransactionQueue('streams')
  const cellQueue = TransactionQueue('cells')
  const computedQueue = TransactionQueue('computed')

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
    debugLog('TransactionManager', 'transact events')
    // First perform all events
    streamQueue.transact()
    debugLog('TransactionManager', 'transact cells')
    // Then perform all cell updates
    cellQueue.transact()

    debugLog('TransactionManager', 'transact computed')
    // Finally, update computed cells
    computedQueue.transact()
    isScheduled = false
    debugLog('TransactionManager', 'transaction end')
  }

  const withCells = <T>(
    perform: (value: T) => void,
    value: T,
    choose: (left: T, right: T) => T = chooseLeft
  ) => {
    debugLog('withCells', 'queue job')
    cellQueue.withTransaction(perform, value, choose)
    schedule()
  }

  const withStreams = <T>(
    perform: (value: T) => void,
    value: T,
    choose: (left: T, right: T) => T = chooseLeft
  ) => {
    debugLog('withStreams', 'queue job')
    streamQueue.withTransaction(perform, value, choose)
    schedule()
  }

  const withComputed = <T>(
    perform: (value: T) => void,
    value: T,
    choose: (left: T, right: T) => T = chooseLeft
  ) => {
    debugLog('withComputed', 'queue job')
    computedQueue.withTransaction(perform, value, choose)
    schedule()
  }

  return {withCells, withStreams, withComputed}
}

const {withCells, withStreams, withComputed} = TransactionManager()

export type Cancel = () => void

export type Send<T> = {
  send: (value: T) => void
}

export type Sink<T> = {
  sink: (subscriber: Send<T>) => Cancel
}

/**
 * Create one-to-many event broadcast channel for a list of subscribers.
 * Publishes synchronously to all subscribers.
 */
const Topic = <T>() => {
  const subscribers = new Set<Send<T>>()

  /** Get subscribers */
  const subs = () => subscribers.values()

  const send = (value: T) => {
    for (const subscriber of subscribers) {
      subscriber.send(value)
    }
  }

  const sink = (subscriber: Send<T>): Cancel => {
    subscribers.add(subscriber)
    return () => subscribers.delete(subscriber)
  }

  return {send, sink, subs}
}

const combineCancels = (cancels: Array<Cancel>): Cancel => () => {
  for (const cancel of cancels) {
    cancel()
  }
}

export const Stream = <T>() => {
  const topic = Topic<T>()
  const send = (value: T) => withStreams(topic.send, value)
  const sink = (subscriber: Send<T>) => topic.sink(subscriber)
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
  const {send, sink} = Stream<T>()
  const cancel = produce(send) ?? noOp
  return {cancel, sink}
}

export const mapStream = <T, U>(
  upstream: Sink<T>,
  transform: (value: T) => U
) => generateStream(send => {
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

export const get = <T>(container: Gettable<T>) => container.get()

export type CellLike<T> = Gettable<T> & Sink<T>

export const Cell = <T>(initial: T, name: string) => {
  const topic = Topic<T>()
  let state = initial

  const get = () => state
  const getName = () => name

  const setState = (value: T) => {
    // Only notify downstream if state has changed value
    if (!isEqual(state, value)) {
      state = value
      topic.send(value)
    }
  }

  const send = (value: T) => {
    withCells(setState, value)
  }

  const sink = (subscriber: Send<T>) => {
    subscriber.send(state)
    return topic.sink(subscriber)
  }

  return {get, name: getName, send, sink}
}

export const Computed = <T>(
  upstreams: Array<CellLike<any>>,
  calc: (...values: Array<any>) => T
) => {
  const topic = Topic<T>()

  const recalc = (): T => calc(...upstreams.map(get))

  let isDirty = false
  let state = recalc()

  const markDirty = () => isDirty = true

  const subject = {
    send: (value: T) => {
      withComputed(markDirty, value)
    }
  }

  const cancel = combineCancels(upstreams.map(cell => cell.sink(subject)))

  const get = () => {
    if (isDirty) {
      state = recalc()
      isDirty = false
    }
    return state
  }

  const sink = (subscriber: Send<T>) => topic.sink(subscriber)

  return {get, sink, cancel}
}

/**
 * "Hold" the latest value from a stream in a cell
 * @param stream - the stream to update cell
 * @param initial - the initial value for the cell
 * @returns cell
 */
export const hold = <T>(stream: Sink<T>, initial: T) => {
  const {get, sink, send} = Cell(initial, 'hold')
  const cancel = stream.sink({
    send: value => send(value)
  })
  return {get, sink, cancel}
}
