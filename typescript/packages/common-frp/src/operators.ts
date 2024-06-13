import {
  map as mapStream,
  filter as filterStream,
  join as joinStreams,
  chooseLeft,
  scan as scanStream,
  hold as holdStream,
  Stream
} from './stream.js'

export type UnaryFn<A, B> = (a: A) => B

export type Pipe = {
  <A, B>(
    value: A,
    a2b: UnaryFn<A, B>
  ): B

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

  (
    value: any,
    ...fns: [(value: any) => any]
  ): any
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
export const join = <T>(
  right: Stream<T>,
  choose: (left: T, right: T) => T = chooseLeft,
) => (
  left: Stream<T>,
) => joinStreams(
  left,
  right,
  choose
)

/** Scan a stream, accumulating step state in a signal */
export const scan = <T, U>(
  step: (state: U, value: T) => U, initial: U
) => (stream: Stream<T>) => scanStream(stream, step, initial)

/** Hold the latest value of a stream in a signal */
export const hold = <T>(
  initial: T
) => (stream: Stream<T>) => holdStream(stream, initial)
