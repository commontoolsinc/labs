import {
  map as mapStream,
  select as selectStream,
  filter as filterStream,
  zip as zipStreams,
  scan as scanStream,
  hold as holdStream,
  Stream
} from './stream'

export type UnaryFn<A, B> = (a: A) => B

export type Pipe = {
  <A, B, C>(
    value: A,
    a2b: UnaryFn<A, B>,
    b2c: UnaryFn<B, C>
  ): C

  <A, B, C, D>(
    value: A,
    a2b: UnaryFn<A, B>,
    b2c: UnaryFn<B, C>,
    c2d: UnaryFn<C, D>
  ): D

  <A, B, C, D, E>(
    value: A,
    a2b: UnaryFn<A, B>,
    b2c: UnaryFn<B, C>,
    c2d: UnaryFn<C, D>,
    d2e: UnaryFn<D, E>
  ): E

  <A, B, C, D, E, F>(
    value: A,
    a2b: UnaryFn<A, B>,
    b2c: UnaryFn<B, C>,
    c2d: UnaryFn<C, D>,
    d2e: UnaryFn<D, E>,
    e2f: UnaryFn<E, F>
  ): F

  <A, B, C, D, E, F, G>(
    value: A,
    a2b: UnaryFn<A, B>,
    b2c: UnaryFn<B, C>,
    c2d: UnaryFn<C, D>,
    d2e: UnaryFn<D, E>,
    e2f: UnaryFn<E, F>,
    f2g: UnaryFn<F, G>
  ): G

  <A, B, C, D, E, F, G, H>(
    value: A,
    a2b: UnaryFn<A, B>,
    b2c: UnaryFn<B, C>,
    c2d: UnaryFn<C, D>,
    d2e: UnaryFn<D, E>,
    e2f: UnaryFn<E, F>,
    f2g: UnaryFn<F, G>,
    g2h: UnaryFn<G, H>
  ): H

  <A, B, C, D, E, F, G, H, I>(
    value: A,
    a2b: UnaryFn<A, B>,
    b2c: UnaryFn<B, C>,
    c2d: UnaryFn<C, D>,
    d2e: UnaryFn<D, E>,
    e2f: UnaryFn<E, F>,
    f2g: UnaryFn<F, G>,
    g2h: UnaryFn<G, H>,
    h2i: UnaryFn<H, I>
  ): I
}

/** Pipe a value through a series of functions */
export const pipe: Pipe = (
  value: any,
  ...fns: [(value: any) => any]
): any => fns.reduce((value: any, fn: UnaryFn<any, any>) => fn(value), value)

/** Map a stream of values */
export const map = <T, U>(
  transform: UnaryFn<T, U>
) => (
  stream: Stream<T>
) => mapStream(stream, transform)

export const select = <T extends object, U extends keyof T & string>(
  key: U
) => (
  stream: Stream<T>
) => selectStream(stream, key)

/** Filter a stream of values using a predicate function. */
export const filter = <T>(
  predicate: UnaryFn<T, boolean>
) => (
  stream: Stream<T>
) => filterStream(stream, predicate)

/**
 * Zip two streams together.
 * Will buffer left and right values until both are available.
 */
export const zip = <T, U, V>(
  right: Stream<U>
) => (
  left: Stream<T>,
  combine: (left: T, right: U) => V,
) => zipStreams(
  left,
  right,
  combine
)

/** Scan a stream, accumulating step state in a cell */
export const scan = <T, U>(
  step: (state: U, value: T) => U, initial: U
) => (stream: Stream<T>) => scanStream(stream, step, initial)

/** Hold the latest value of a stream in a cell */
export const hold = <T>(
  initial: T
) => (stream: Stream<T>) => holdStream(stream, initial)