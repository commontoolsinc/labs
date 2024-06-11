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
): any => fns.reduce((value: any, fn: UnaryFn<any, any>) => fn(value), value);
