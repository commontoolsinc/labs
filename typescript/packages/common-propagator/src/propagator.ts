import { Cancel, Cancellable, useCancelGroup } from "./cancel.js";
import * as logger from "./logger.js";
import { Lens } from "./lens.js";
import cid from "./cid.js";
import { merge } from "./mergeable.js";
import withTransaction from "./scheduler.js";

/**
 * A cell is a reactive value that can be updated and subscribed to.
 */
export class Cell<Value> {
  static get<Value>(cell: Cell<Value>) {
    return cell.get();
  }

  #id = cid();
  #name = "";
  #neighbors = new Set<(value: Value) => void>();
  #value: Value;

  constructor(value: Value, name = "") {
    this.#name = name;
    this.#value = value;
    logger.debug({
      msg: "Cell created",
      cell: this.id,
      name: this.name,
      value: this.#value,
    });
  }

  get id() {
    return this.#id;
  }

  get name() {
    return this.#name;
  }

  get() {
    return this.#value;
  }

  send(value: Value) {
    logger.debug({
      msg: "Sent value",
      cell: this.id,
      value,
    });

    withTransaction(this.id, () => {
      const next = merge(this.#value, value);

      // We only advance clock if value changes state
      if (this.#value === next) {
        logger.debug({
          msg: "Value unchanged. Ignoring.",
          cell: this.id,
          value: next,
        });
        return;
      }

      logger.debug({
        msg: "Update value",
        cell: this.id,
        prev: this.#value,
        value: next,
      });

      this.#value = next;

      logger.debug({
        msg: "Notify neighbors",
        cell: this.id,
        neighbors: this.#neighbors.size,
      });
      // Notify neighbors
      for (const neighbor of this.#neighbors) {
        neighbor(next);
      }
    });
  }

  /** Disconnect all neighbors */
  disconnect() {
    logger.debug({
      msg: "Disconnect all neighbors",
      cell: this.id,
      neighbors: this.#neighbors.size,
    });
    this.#neighbors.clear();
  }

  sink(callback: (value: Value) => void) {
    callback(this.#value);
    this.#neighbors.add(callback);
    return () => {
      this.#neighbors.delete(callback);
    };
  }

  key<K extends keyof Value>(valueKey: K) {
    return key(this, valueKey);
  }
}

/** Create a reactive cell for a value */
export const cell = <Value>(value: Value, name = "") => new Cell(value, name);

export default cell;

export type CancellableCell<T> = Cell<T> & Cancellable;

/**
 * Derive a cell who's contents is transformed by a lens
 */
export const lens = <B, S>(
  big: Cell<B>,
  lens: Lens<B, S>,
): CancellableCell<S> => {
  const bigValue = big.get();

  const small = cell<S>(lens.get(bigValue));

  const [cancel, addCancel] = useCancelGroup();

  // Propagate writes from parent to child
  const cancelBigToSmall = big.sink((bigValue) => {
    small.send(lens.get(bigValue));
  });
  addCancel(cancelBigToSmall);

  // Propagate writes from child to parent
  const cancelSmallToBig = small.sink((smallValue) => {
    const bigValue = big.get();
    const currSmallValue = lens.get(bigValue);
    if (currSmallValue !== smallValue) {
      big.send(lens.update(bigValue, smallValue));
    }
  });
  addCancel(cancelSmallToBig);

  const cancellableSmall = small as CancellableCell<S>;
  cancellableSmall.cancel = cancel;

  return cancellableSmall;
};

export const key = <T, K extends keyof T>(
  big: Cell<T>,
  key: K,
): CancellableCell<T[K]> =>
  lens(big, {
    get: (big) => big[key],
    update: (big, small) => ({ ...big, [key]: small }),
  });

export function lift<A, B>(fn: (a: A) => B): (a: Cell<A>, b: Cell<B>) => Cancel;
export function lift<A, B, C>(
  fn: (a: A, b: B) => C,
): (a: Cell<A>, b: Cell<B>, c: Cell<C>) => Cancel;
export function lift<A, B, C, D>(
  fn: (a: A, b: B, c: C) => D,
): (a: Cell<A>, b: Cell<B>, c: Cell<C>, d: Cell<D>) => Cancel;
export function lift<A, B, C, D, E>(
  fn: (a: A, b: B, c: C, d: D) => E,
): (a: Cell<A>, b: Cell<B>, c: Cell<C>, d: Cell<D>, e: Cell<E>) => Cancel;
export function lift<A, B, C, D, E, F>(
  fn: (a: A, b: B, c: C, d: D, e: E) => F,
): (
  a: Cell<A>,
  b: Cell<B>,
  c: Cell<C>,
  d: Cell<D>,
  e: Cell<E>,
  f: Cell<F>,
) => Cancel;
export function lift<A, B, C, D, E, F, G>(
  fn: (a: A, b: B, c: C, d: D, e: E, f: F) => G,
): (
  a: Cell<A>,
  b: Cell<B>,
  c: Cell<C>,
  d: Cell<D>,
  e: Cell<E>,
  f: Cell<F>,
  g: Cell<G>,
) => Cancel;
export function lift<A, B, C, D, E, F, G, H>(
  fn: (a: A, b: B, c: C, d: D, e: E, f: F, g: G) => H,
): (
  a: Cell<A>,
  b: Cell<B>,
  c: Cell<C>,
  d: Cell<D>,
  e: Cell<E>,
  f: Cell<F>,
  g: Cell<G>,
  h: Cell<H>,
) => Cancel;
export function lift<A, B, C, D, E, F, G, H, I>(
  fn: (a: A, b: B, c: C, d: D, e: E, f: F, g: G, h: H) => I,
): (
  a: Cell<A>,
  b: Cell<B>,
  c: Cell<C>,
  d: Cell<D>,
  e: Cell<E>,
  f: Cell<F>,
  g: Cell<G>,
  h: Cell<H>,
  i: Cell<I>,
) => Cancel;
export function lift(fn: (...args: unknown[]) => unknown) {
  return (...cells: Cell<unknown>[]): Cancel => {
    if (cells.length < 2) {
      throw new TypeError("lift requires at least 2 cells");
    }

    const [cancel, addCancel] = useCancelGroup();

    const output = cells.pop()!;

    const id = cid();
    for (const cell of cells) {
      const cancel = cell.sink((_value) => {
        withTransaction(id, () => {
          output.send(fn(...cells.map(Cell.get)));
        });
      });
      addCancel(cancel);
    }

    return cancel;
  };
}
