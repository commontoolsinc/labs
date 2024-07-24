import { Cancellable, useCancelGroup } from "./cancel.js";
import * as logger from "./logger.js";

const advanceClock = (a: number, b: number) => Math.max(a, b) + 1;

export const lww = <T>(_state: T, next: T) => next;

export type LamportTime = number;

/**
 * A cell is a reactive value that can be updated and subscribed to.
 */
export class Cell<Value> {
  #name: string = "";
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
  }

  get name() {
    return this.#name;
  }

  get() {
    return this.#value;
  }

  send(value: Value, time: LamportTime = this.#time + 1): number {
    logger.debug(`cell#${this.name}`, "Message", value, time);

    // We ignore old news
    if (this.#time >= time) {
      logger.debug(
        `cell#${this.name}`,
        "Message out of date. Ignoring.",
        value,
        time,
      );
      return this.#time;
    }

    this.#time = advanceClock(this.#time, time);
    logger.debug(`cell#${this.name}`, "Advanced clock", this.#time);

    const next = this.#update(this.#value, value);

    // We only advance clock if msg changed state
    if (this.#value === next) {
      logger.debug(`cell#${this.name}`, "Value unchanged.", this.#value);
      return this.#time;
    }

    const prev = this.#value;
    this.#value = next;
    logger.debug(`cell#${this.name}`, "Value updated", prev, next);

    // Notify neighbors
    for (const neighbor of this.#neighbors) {
      neighbor(next, this.#time);
    }
    logger.debug(
      `cell#${this.name}`,
      "Notified neighbors",
      this.#neighbors.size,
    );

    return this.#time;
  }

  /** Disconnect all neighbors */
  disconnect() {
    this.#neighbors.clear();
    logger.debug(
      `cell#${this.name}`,
      "Disconnected all neighbors",
      this.#neighbors.size,
    );
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

/**
 * Create a reactive cell for a value
 */
export const cell = <Value>({
  value,
  name = "",
  update = lww,
}: {
  value: Value;
  name?: string;
  update?: (state: Value, next: Value) => Value;
}) => new Cell({ value, name, update });

export type CancellableCell<T> = Cell<T> & Cancellable;

export const lens = <B, S>({
  cell: big,
  get,
  update,
}: {
  cell: Cell<B>;
  get: (big: B) => S;
  update: (big: B, small: S) => B;
}): CancellableCell<S> => {
  const bigValue = big.get();

  const small = cell<S>({ value: get(bigValue) });

  const [cancel, addCancel] = useCancelGroup();

  // Propagate writes from parent to child
  const cancelBigToSmall = big.sink((parentValue, time) => {
    small.send(get(parentValue), time);
  });
  addCancel(cancelBigToSmall);

  // Propagate writes from child to parent
  const cancelSmallToBig = small.sink((value, time) => {
    big.send(update(big.get(), value), time);
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
  lens({
    cell: big,
    get: (big) => big[key],
    update: (big, small) => ({ ...big, [key]: small }),
  });
