import { Cancel, Cancellable, useCancelGroup } from "./cancel.js";
import * as logger from "./logger.js";
import { Lens } from "./lens.js";
import cid from "./cid.js";

export type LamportTime = number;

const advanceClock = (...times: LamportTime[]) => Math.max(...times) + 1;

export const lww = <T>(_state: T, next: T) => next;

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
  #update: (state: Value, next: Value) => Value;
  #value: Value;

  constructor({
    value,
    name = "",
    update = lww,
  }: {
    value: Value;
    name?: string;
    update?: (state: Value, next: Value) => Value;
  }) {
    this.#name = name;
    this.#update = update;
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

    // We only advance clock if value changes state
    if (this.#value === value) {
      logger.debug({
        msg: "Value unchanged. Ignoring.",
        cell: this.id,
        value,
        time,
      });
      return this.#time;
    }

    this.#time = advanceClock(this.#time, time);

    const next = this.#update(this.#value, value);
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
export const cell = <Value>({
  value,
  name = "",
  update = lww,
}: {
  value: Value;
  name?: string;
  update?: (state: Value, next: Value) => Value;
}) => new Cell({ value, name, update });

export default cell;

/** Create a cell with last-write-wins update semantics */
export const state = <T>(value: T, name = "") => cell({ value, name });

export type CancellableCell<T> = Cell<T> & Cancellable;

/**
 * Derive a cell who's contents is transformed by a lens
 */
export const lens = <B, S>(
  big: Cell<B>,
  lens: Lens<B, S>,
): CancellableCell<S> => {
  const bigValue = big.get();

  const small = cell<S>({ value: lens.get(bigValue) });

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
