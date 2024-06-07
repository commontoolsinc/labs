import { debug } from './shared.js'
import {
  publisher,
  Send,
  Cancel,
  Cancellable,
  combineCancels
} from './publisher.js'

const createTransactionManager = () => {
  const updates = new Map<(value: any) => void, any>()
  const reads = new Set<() => void>()

  let isScheduled = false

  const schedule = () => {
    if (isScheduled) {
      return
    }
    debug('TransactionManager.schedule', 'transaction scheduled')
    isScheduled = true
    queueMicrotask(transact)
  }

  const transact = () => {
    // First perform all signal state changes.
    // - Update signal state
    // - Mark computed dirty
    debug('TransactionManager.transact', 'updates')
    for (const [job, value] of updates) {
      job(value)
    }
    updates.clear()
    // Then perform all signal state reads
    // - Read signal state
    // - Recompute computed signals and mark clean
    debug('TransactionManager.transact', 'reads')
    for (const job of reads) {
      job()
    }
    reads.clear()
    isScheduled = false
    debug('TransactionManager.transact', 'transaction end')
  }

  const withUpdates = <T>(job: (value: T) => void, value: T) => {
    debug('TransactionManager.withUpdates', 'queue job', job, value)
    updates.set(job, value)
    schedule()
  }

  const withReads = (job: () => void) => {
    debug('TransactionManager.withReads', 'queue job', job)
    reads.add(job)
    schedule()
  }

  return { withUpdates, withReads }
}

const { withUpdates, withReads } = createTransactionManager()

/** Symbol for updates subscribe method */
export const __updates__ = Symbol('updates')

export type Updates<T> = {
  [__updates__]: (subscriber: Send<T>) => Cancel
}

export type Subject<T> = {
  send: (value: T) => void
}

const isEqual = Object.is

export type Gettable<T> = {
  get(): T
}

const sample = <T>(container: Gettable<T>) => container.get()

export type Signal<T> = Gettable<T> & Updates<void> & Cancellable
export type SignalSubject<T> = Gettable<T> & Updates<void> & Subject<T>

/** React to a signal, producing an effect any time it changes */
export const effect = <T>(
  signal: Signal<T>,
  effect: Send<T>
) => {
  const job = () => effect(signal.get())
  job()
  return signal[__updates__](() => withReads(job))
}

export const state = <T>(initial: T) => {
  const updates = publisher<void>()

  let state = initial

  const get = () => state

  const performUpdate = (value: T) => {
    // Only perform update if state has actually changed
    if (!isEqual(state, value)) {
      state = value
      debug('state', 'value updated', state)
      updates.pub()
    }
  }

  const send = (value: T) => withUpdates(performUpdate, value)

  return {
    get,
    send,
    [__updates__]: updates.sub
  }
}

export type Computed = {
  <A, B, Z>(
    upstreams: [Signal<A>, Signal<B>],
    compute: (a: A, b: B) => Z
  ): Signal<Z>
  <A, B, C, Z>(
    upstreams: [Signal<A>, Signal<B>, Signal<C>],
    compute: (a: A, b: B, c: C) => Z
  ): Signal<Z>
  <A, B, C, D, Z>(
    upstreams: [Signal<A>, Signal<B>, Signal<C>, Signal<D>],
    compute: (a: A, b: B, c: C, d: D) => Z
  ): Signal<Z>
  <A, B, C, D, E, Z>(
    upstreams: [
      Signal<A>,
      Signal<B>,
      Signal<C>,
      Signal<D>,
      Signal<E>],
    compute: (a: A, b: B, c: C, d: D, e: E) => Z
  ): Signal<Z>
  <A, B, C, D, E, F, Z>(
    upstreams: [
      Signal<A>,
      Signal<B>,
      Signal<C>,
      Signal<D>,
      Signal<E>,
      Signal<F>
    ],
    compute: (a: A, b: B, c: C, d: D, e: E, f: F) => Z
  ): Signal<Z>
  <A, B, C, D, E, F, G, Z>(
    upstreams: [
      Signal<A>,
      Signal<B>,
      Signal<C>,
      Signal<D>,
      Signal<E>,
      Signal<F>,
      Signal<G>
    ],
    compute: (a: A, b: B, c: C, d: D, e: E, f: F, g: G) => Z
  ): Signal<Z>
  <A, B, C, D, E, F, G, H, Z>(
    upstreams: [
      Signal<A>,
      Signal<B>,
      Signal<C>,
      Signal<D>,
      Signal<E>,
      Signal<F>,
      Signal<G>,
      Signal<H>
    ],
    compute: (a: A, b: B, c: C, d: D, e: E, f: F, g: G, h: H) => Z
  ): Signal<Z>
  (
    upstreams: Array<Signal<any>>,
    compute: (...values: any) => any
  ): Signal<any>
}

export const computed: Computed = (
  upstreams: Array<Signal<any>>,
  compute: (...values: Array<any>) => any
): Signal<any> => {
  const updates = publisher<void>()

  const recompute = () => compute(...upstreams.map(sample))

  let isDirty = false
  let state = recompute()

  const performUpdate = () => {
    debug('computed', 'mark dirty')
    isDirty = true
    updates.pub()
  }

  const cancel = combineCancels(
    upstreams.map(signal => signal[__updates__](performUpdate))
  )

  const get = () => {
    if (isDirty) {
      state = recompute()
      debug('computed', 'recomputed state', state)
      isDirty = false
    }
    return state
  }

  return {
    get,
    [__updates__]: updates.sub,
    cancel
  }
}
