export const config = {
  debug: false
}

const debugLog = (msg: string) => {
  if (config.debug) {
    console.debug(msg)
  }
}

/**
 * Pipe a value through a series of functions
 * @param value - The value to pipe
 * @param funcs - The functions to pipe the value through
 * @returns The final value after being piped through all functions
 */
export const pipe = (
  value: any,
  ...funcs: Array<(value: any) => any>
) => funcs.reduce((acc, func) => func(acc), value)

export const chooseLeft = <T>(left: T, right: T) => left

const TransactionQueue = (name: string) => {
  const queue = new Map<(value: any) => void, any>()

  const transact = () => {
    debugLog(`TransactionQueue ${name}: transacting ${queue.size} jobs`)
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
    debugLog(`TransactionManager: transaction scheduled`)
    isScheduled = true
    queueMicrotask(transact)
  }

  const transact = () => {
    debugLog(`TransactionManager: transaction start`)
    debugLog(`TransactionManager: transact events`)
    // First perform all events
    streamQueue.transact()
    debugLog(`TransactionManager: transact cells`)
    // Then perform all cell updates
    cellQueue.transact()

    debugLog(`TransactionManager: transact computed`)
    // Finally, update computed cells
    computedQueue.transact()
    isScheduled = false
    debugLog(`TransactionManager: transaction end`)
  }

  const withCells = <T>(
    perform: (value: T) => void,
    value: T,
    choose: (left: T, right: T) => T = chooseLeft
  ) => {
    cellQueue.withTransaction(perform, value, choose)
    schedule()
  }

  const withStreams = <T>(
    perform: (value: T) => void,
    value: T,
    choose: (left: T, right: T) => T = chooseLeft
  ) => {
    streamQueue.withTransaction(perform, value, choose)
    schedule()
  }

  const withComputed = <T>(
    perform: (value: T) => void,
    value: T,
    choose: (left: T, right: T) => T = chooseLeft
  ) => {
    computedQueue.withTransaction(perform, value, choose)
    schedule()
  }

  return {withCells, withStreams, withComputed}
}

const {withCells, withStreams, withComputed} = TransactionManager()

type Topic<T> = {
  notify: (value: T) => void,
  sink: (subscriber: (value: T) => void) => () => void
}

/**
 * Create one-to-many event broadcast channel for a list of subscribers.
 * Publishes synchronously to all subscribers.
 */
const Topic = <T>(): Topic<T> => {
  const subscribers = new Set<(value: T) => void>()

  const notify = (value: T) => {
    for (const subscriber of subscribers) {
      subscriber(value)
    }
  }

  const sink = (subscriber: (value: T) => void) => {
    subscribers.add(subscriber)
    return () => subscribers.delete(subscriber)
  }

  return {notify, sink}
}

export type Send<T> = (value: T) => void

type Streamable<T> = {
  sink: (subscriber: (value: T) => void) => () => void
}

export class Stream<T> implements Streamable<T> {
  #topic: Topic<T>
  #choose: (left: T, right: T) => T

  constructor(
    choose: (left: T, right: T) => T = chooseLeft  
  ) {
    this.#topic = Topic<T>()
    this.#choose = choose
  }

  send(value: T) {
    withStreams(this.#topic.notify, value, this.#choose)
  }

  sink(subscriber: (value: T) => void) {
    return this.#topic.sink(subscriber)
  }
}

export class ReadOnlyStream<T> implements Streamable<T> {
  #stream: Streamable<T>

  constructor(stream: Stream<T>) {
    this.#stream = stream
  }

  sink(subscriber: (value: T) => void) {
    return this.#stream.sink(subscriber)
  }
}

export const useStream = <T>(
  generate: (send: (value: T) => void) => void,
  choose: (left: T, right: T) => T = chooseLeft
): Stream<T> => {
  const {notify, sink} = Topic<T>()

  const send = (value: T) => {
    withStreams(notify, value, choose)
  }

  generate(send)

  return {sink}
}

export const mapStream = <T, U>(
  stream: Stream<T>,
  map: (value: T) => U
) => useStream(send => {
  stream.sink(value => send(map(value)))
})

export const scanStream = <T, U>(
  stream: Stream<T>,
  step: (state: U, value: T) => U,
  initial: U
) => {
  let state = initial
  return useStream(send => {
    stream.sink(value => {
      state = step(state, value)
      send(state)
    })
  })
}

export const mergeStreams = <T>(
  left: Stream<T>,
  right: Stream<T>,
  choose: (left: T, right: T) => T = chooseLeft
) => useStream(send => {
  left.sink(value => send(value))
  right.sink(value => send(value))
})

/**
 * "Hold" the latest value from a stream in a cell
 * @param stream - the stream to update cell
 * @param initial - the initial value for the cell
 * @returns cell
 */
export const hold = <T>(stream: Stream<T>, initial: T): Cell<T> => {
  const [cell, send] = useCell(initial)
  stream.sink(send)
  return cell
}


const isEqual = Object.is

export type Cell<T> = {
  get: () => T,
  sink: (subscriber: (value: T) => void) => () => void
}

export const useCell = <T>(value: T): [Cell<T>, Send<T>] => {
  const {notify, sink} = Topic<T>()
  let state = value

  const setState = (value: T) => {
    // Only notify downstream if state has changed
    if (!isEqual(state, value)) {
      state = value
      notify(value)
    }
  }

  const get = () => state

  const send = (value: T) => {
    withCells(notify, value)
  }

  return [{get, sink}, send]
}

export const useComputed = <T>(
  upstream: Array<Cell<any>>,
  calc: () => T
): Cell<T> => {
  const {notify, sink} = Topic<T>()
  let state = calc()
  let isDirty = false

  const setState = (value: T) => {
    // Only notify downstream if state has changed
    if (!isEqual(state, value)) {
      state = value
      notify(value)
    }
  }

  const get = () => {
    if (isDirty) {
      state = calc()
      isDirty = false
    }
    return state
  }

  const markDirty = () => {
    isDirty = true
    withComputed(notify, calc())
  }

  for (const cell of upstream) {
    cell.sink(markDirty)
  }

  const send = (value: T) => {
    withComputed(notify, value)
  }

  return {get, sink}
}