import { Cancel, Cancellable, useCancelGroup } from "./cancel.js";
import debug from "./debug.js";
import * as logger from "./logger.js";
import { Lens } from "./lens.js";
import cid from "./cid.js";
import { merge } from "./mergeable.js";
import scheduler from "./scheduler.js";
import { AnyTask, task } from "./task.js";
import { Causes, shouldUpdate, State } from "./state.js";
/**
 * A cell is a reactive value that can be updated and subscribed to.
 */
export class Cell<T> {
  static get<T>(cell: Cell<T>) {
    return cell.get();
  }

  #id = cid();
  #name = "";
  #neighbors = new Set<AnyTask>();
  #value: T;

  constructor(value: T, name = "") {
    this.#name = name;
    this.#value = value;
    if (debug()) {
      logger.debug({
        topic: "cell",
        msg: "Cell created",
        id: this.id,
        name: this.name,
        value: this.#value,
      });
    }
  }

  get id() {
    return this.#id;
  }

  get name() {
    return this.#name;
  }

  get(): T {
    return this.#value;
  }

  send(value: T) {
    if (debug()) {
      logger.debug({
        topic: "cell",
        msg: "Sent value",
        id: this.id,
        value,
      });
    }
    const next = merge(this.#value, value);

    // We only advance clock if value changes state
    if (this.#value === next) {
      if (debug()) {
        logger.debug({
          topic: "cell",
          msg: "Value unchanged. Ignoring.",
          id: this.id,
          value: next,
        });
      }
      return;
    }

    if (debug()) {
      logger.debug({
        topic: "cell",
        msg: "Updating value",
        id: this.id,
        prev: this.#value,
        value: next,
      });
    }
    this.#value = next;

    // Notify neighbors
    scheduler.queue(...this.#neighbors);
  }

  /** Disconnect all neighbors */
  disconnectAll() {
    if (debug()) {
      logger.debug({
        topic: "cell",
        msg: "Disconnect all neighbors",
        id: this.id,
        neighbors: this.#neighbors.size,
      });
    }
    this.#neighbors.clear();
  }

  connect(task: AnyTask) {
    this.#neighbors.add(task);
    scheduler.queue(task);
    return () => {
      this.#neighbors.delete(task);
    };
  }

  sink(callback: (value: T) => void) {
    return this.connect(task(() => callback(this.get())));
  }

  key<K extends keyof T>(valueKey: K) {
    return key(this, valueKey);
  }
}

/** Create a reactive cell for a value */
export const cell = <Value>(value: Value, name = "") => new Cell(value, name);

export default cell;

export type StateCell<T> = Cell<State<T>>;

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

const getCellStateValue = <T>(stateCell: StateCell<T>): T =>
  stateCell.get().value;

export function lift<A, B>(
  fn: (a: A) => B,
): (a: StateCell<A>, b: StateCell<B>) => Cancel;
export function lift<A, B, C>(
  fn: (a: A, b: B) => C,
): (a: StateCell<A>, b: StateCell<B>, c: StateCell<C>) => Cancel;
export function lift<A, B, C, D>(
  fn: (a: A, b: B, c: C) => D,
): (
  a: StateCell<A>,
  b: StateCell<B>,
  c: StateCell<C>,
  d: StateCell<D>,
) => Cancel;
export function lift<A, B, C, D, E>(
  fn: (a: A, b: B, c: C, d: D) => E,
): (
  a: StateCell<A>,
  b: StateCell<B>,
  c: StateCell<C>,
  d: StateCell<D>,
  e: StateCell<E>,
) => Cancel;
export function lift<A, B, C, D, E, F>(
  fn: (a: A, b: B, c: C, d: D, e: E) => F,
): (
  a: StateCell<A>,
  b: StateCell<B>,
  c: StateCell<C>,
  d: StateCell<D>,
  e: StateCell<E>,
  f: StateCell<F>,
) => Cancel;
export function lift<A, B, C, D, E, F, G>(
  fn: (a: A, b: B, c: C, d: D, e: E, f: F) => G,
): (
  a: StateCell<A>,
  b: StateCell<B>,
  c: StateCell<C>,
  d: StateCell<D>,
  e: StateCell<E>,
  f: StateCell<F>,
  g: StateCell<G>,
) => Cancel;
export function lift<A, B, C, D, E, F, G, H>(
  fn: (a: A, b: B, c: C, d: D, e: E, f: F, g: G) => H,
): (
  a: StateCell<A>,
  b: StateCell<B>,
  c: StateCell<C>,
  d: StateCell<D>,
  e: StateCell<E>,
  f: StateCell<F>,
  g: StateCell<G>,
  h: StateCell<H>,
) => Cancel;
export function lift<A, B, C, D, E, F, G, H, I>(
  fn: (a: A, b: B, c: C, d: D, e: E, f: F, g: G, h: H) => I,
): (
  a: StateCell<A>,
  b: StateCell<B>,
  c: StateCell<C>,
  d: StateCell<D>,
  e: StateCell<E>,
  f: StateCell<F>,
  g: StateCell<G>,
  h: StateCell<H>,
  i: StateCell<I>,
) => Cancel;
export function lift(fn: (...args: unknown[]) => unknown) {
  return (...cells: StateCell<unknown>[]): Cancel => {
    if (cells.length < 2) {
      throw new TypeError("lift requires at least 2 cells");
    }

    const [cancel, addCancel] = useCancelGroup();

    const output = cells.pop()!;

    const recompute = () => fn(...cells.map(getCellStateValue));

    // Create a map of cell IDs to causes.
    // We use this as a vector clock when updating.
    // All cells are initialized to t=-1 since we will have never seen
    // an update from any of the cells. This will get immediately replaced
    // by the first immediate update we get from sink.
    let mergedCauses: Causes = Object.assign(
      {},
      ...cells.map((cell) => cell.get().causes),
    );

    output.send(output.get().next(recompute(), mergedCauses));

    for (const cell of cells) {
      const cancel = cell.connect(
        task(() => {
          const currentState = output.get();

          const nextPartialState = cell.get();
          if (!shouldUpdate(mergedCauses, nextPartialState.causes)) {
            return;
          }

          // Update our causal clock
          Object.assign(mergedCauses, nextPartialState.causes);

          // Recalculate the output value
          const nextValue = recompute();

          if (debug()) {
            logger.debug({
              topic: "lift",
              msg: "updated",
              value: nextValue,
              causes: mergedCauses,
            });
          }

          output.send(currentState.next(nextValue, mergedCauses));
        }),
      );
      addCancel(cancel);
    }

    return cancel;
  };
}
