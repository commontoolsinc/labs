import { Cancel, Cancellable, useCancelGroup } from "./cancel.js";
import * as logger from "./logger.js";
import { Lens } from "./lens.js";
import cid from "./cid.js";

/** A mergeable is a type that knows how to merge itself with itself */
export interface Mergeable {
  merge(value: this): this;
}

export const isMergeable = (value: any): value is Mergeable => {
  return (
    typeof value === "object" &&
    typeof value.merge === "function" &&
    value.merge.length === 1
  );
};

/**
 * Merge will merge prev and curr if they are mergeable, otherwise will
 * return curr.
 */
const merge = <T>(prev: T, curr: T): T => {
  if (isMergeable(prev) && isMergeable(curr)) {
    return prev.merge(curr);
  }
  return curr;
};

export type LamportTime = number;

const advanceClock = (...times: LamportTime[]) => Math.max(...times) + 1;

/**
 * A cell is a reactive value that can be updated and subscribed to.
 */
export class Cell<Value> {
  static get<Value>(cell: Cell<Value>) {
    return cell.get();
  }

  static time<Value>(cell: Cell<Value>) {
    return cell.time;
  }

  #id = cid();
  #name = "";
  #neighbors = new Set<(value: Value, time: LamportTime) => void>();
  #time: LamportTime = 0;
  #value: Value;

  constructor(value: Value, name = "") {
    this.#name = name;
    this.#value = value;
    logger.debug({
      msg: "Cell created",
      cell: this.id,
      name: this.name,
      value: this.#value,
      time: this.#time,
    });
  }

  get id() {
    return this.#id;
  }

  get name() {
    return this.#name;
  }

  get time() {
    return this.#time;
  }

  get() {
    return this.#value;
  }

  send(value: Value, time: LamportTime = this.#time + 1): number {
    logger.debug({
      msg: "Sent value",
      cell: this.id,
      value,
      time,
    });

    // We ignore old news.
    // If times are equal, we ignore incoming value.
    if (this.#time >= time) {
      logger.debug({
        msg: "Value out of date. Ignoring.",
        cell: this.id,
        value,
        time,
      });
      return this.#time;
    }

    const next = merge(this.#value, value);

    // We only advance clock if value changes state
    if (this.#value === next) {
      logger.debug({
        msg: "Value unchanged. Ignoring.",
        cell: this.id,
        value: next,
        time,
      });
      return this.#time;
    }

    this.#time = advanceClock(this.#time, time);

    const prev = this.#value;
    this.#value = next;

    logger.debug({
      msg: "Value updated",
      cell: this.id,
      prev,
      value,
      time: this.#time,
    });

    // Notify neighbors
    for (const neighbor of this.#neighbors) {
      neighbor(next, this.#time);
    }

    logger.debug({
      msg: "Notified neighbors",
      cell: this.id,
      neighbors: this.#neighbors.size,
    });

    return this.#time;
  }

  /** Disconnect all neighbors */
  disconnect() {
    const size = this.#neighbors.size;
    this.#neighbors.clear();
    logger.debug({
      msg: "Disconnected all neighbors",
      cell: this.id,
      neighbors: size,
    });
  }

  sink(callback: (value: Value, time: LamportTime) => void) {
    callback(this.#value, this.#time);
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
  const cancelBigToSmall = big.sink((bigValue, time) => {
    small.send(lens.get(bigValue), time);
  });
  addCancel(cancelBigToSmall);

  // Propagate writes from child to parent
  const cancelSmallToBig = small.sink((smallValue, time) => {
    const bigValue = big.get();
    const currSmallValue = lens.get(bigValue);
    if (currSmallValue !== smallValue) {
      big.send(lens.update(bigValue, smallValue), time);
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

    // Create a map of cell IDs to times.
    // We use this as a vector clock when updating.
    // All cells are initialized to t=-1 since we will have never seen
    // an update from any of the cells. This will get immediately replaced
    // by the first immediate update we get from sink.
    const clock = new Map(cells.map((cell) => [cell.id, -1]));

    for (const cell of cells) {
      const cancel = cell.sink((_value, time) => {
        // Get the last time we got an update from this cell
        const lastTime = clock.get(cell.id);
        if (lastTime == null) {
          // This should never happen
          throw Error(`Cell not found in clock: ${cell.id}`);
        }
        // If this cell has updated (e.g. not a "diamond problem"" update)
        // then update the entry in the clock and send the calculated output.
        if (time > lastTime) {
          clock.set(cell.id, time);
          output.send(
            fn(...cells.map(Cell.get)),
            advanceClock(time, output.time),
          );
        }
      });
      addCancel(cancel);
    }

    return cancel;
  };
}
