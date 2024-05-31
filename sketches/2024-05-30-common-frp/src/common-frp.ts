export const config = {
  debug: false
}

const debugLog = (msg: string) => {
  if (config.debug) {
    console.debug(msg)
  }
}

export const chooseLeft = <T>(left: T, _right: T) => left

class TransactionQueue {
  name: string
  #queue = new Map<(value: any) => void, any>()

  constructor(name: string) {
    this.name = name
  }

  transact() {
    debugLog(`TransactionQueue ${this.name}: transacting ${this.#queue.size} jobs`)
    for (const [perform, value] of this.#queue) {
      perform(value)
    }
    this.#queue.clear()
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
  withTransaction = <T>(
    perform: (value: T) => void,
    value: T,
    choose: (left: T, right: T) => T = chooseLeft
  ) => {
    const left = this.#queue.get(perform)
    this.#queue.set(perform, left !== undefined ? choose(left, value) : value)
  }
}

const TransactionManager = () => {
  const streamQueue = new TransactionQueue('streams')
  const cellQueue = new TransactionQueue('cells')
  const computedQueue = new TransactionQueue('computed')

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

export type Send<T> = (value: T) => void
export type Cancel = () => void

type Topic<T> = {
  notify: (value: T) => void,
  sink: (subscriber: Send<T>) => Cancel
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

  const sink = (subscriber: Send<T>): Cancel => {
    subscribers.add(subscriber)
    return () => subscribers.delete(subscriber)
  }

  return {notify, sink}
}

const combineCancels = (cancels: Array<Cancel>): Cancel => () => {
  for (const cancel of cancels) {
    cancel()
  }
}

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
  produce: (send: Send<T>) => void
) => {
  const downstream = new Stream<T>()
  produce(value => downstream.send(value))
  return new ReadOnlyStream(downstream)
}

export const mapStream = <T, U>(
  upstream: Stream<T>,
  transform: (value: T) => U
) => useStream(send => {
  upstream.sink(value => send(transform(value)))
})

export const scanStream = <T, U>(
  upstream: Stream<T>,
  step: (state: U, value: T) => U,
  initial: U
) => useStream(send => {
  let state = initial
  upstream.sink(value => {
    state = step(state, value)
    send(state)
  })
})

const isEqual = Object.is

export type Cellable<T> = {
  readonly value: T,
  sink: (subscriber: (value: T) => void) => () => void
}

export class Cell<T> implements Cellable<T> {
  #name: string
  #value: T
  #topic = Topic<T>()

  constructor(value: T, name: string) {
    this.#value = value
    this.#name = name
  }

  get name() {
    return this.#name
  }

  get value() {
    return this.#value
  }

  #setState = (value: T) => {
      // Only notify downstream if state has changed value
      if (!isEqual(this.#value, value)) {
        this.#value = value
        this.#topic.notify(value)
      }    
  }

  send(value: T) {
    withCells(this.#setState, value)
  }

  sink(subscriber: Send<T>) {
    subscriber(this.#value)
    return this.#topic.sink(subscriber)
  }
}

export const getCell = <T>(cell: Cell<T>) => cell.value

export class ComputedCell<T> implements Cellable<T> {
  #topic = Topic<T>()
  #isDirty = false
  #value: T
  #recalc: () => T
  #upstreams: Array<Cell<any>>
  cancel: Cancel

  constructor(
    upstreams: Array<Cell<any>>,
    calc: (...values: Array<any>) => T
  ) {
    this.#upstreams = upstreams
    this.#recalc = () => calc(...this.#upstreams.map(getCell))
    this.#value = this.#recalc()

    this.cancel = combineCancels(
      upstreams.map(cell => cell.sink(value => {
        withComputed(this.#markDirty, value)
      }))
    )
  }

  #markDirty = () => {
    this.#isDirty = true
  }

  get value() {
    if (this.#isDirty) {
      this.#value = this.#recalc()
      this.#isDirty = false
    }
    return this.#value
  }

  sink(subscriber: Send<T>): () => void {
    return this.#topic.sink(subscriber)
  }
}

/**
 * "Hold" the latest value from a stream in a cell
 * @param stream - the stream to update cell
 * @param initial - the initial value for the cell
 * @returns cell
 */
export const hold = <T>(stream: Stream<T>, initial: T): ComputedCell<T> => {
  const cell = new Cell(initial, 'hold')
  // TODO deal with cancel
  stream.sink(value => cell.send(value))
  return new ComputedCell([cell], (value) => value)
}
