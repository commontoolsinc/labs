export type Task = {
  poll(): void;
};

class Scheduler {
  #transaction = new Set<Task>();
  #isRunning = false;
 
  enqueue(propagators: Iterable<Task>) {
    for (const propagator of propagators) {
      this.#transaction.add(propagator);
    }
    this.#wake();
  }

  #wake() {
    if (!this.#isRunning) {
      this.#isRunning = true;
      const current = this.#transaction;
      this.#transaction = new Set();
      for (const task of current) {
        try {
          task.poll();
        } catch (error) {
          console.error(error);
        }
      }
      this.#isRunning = false
    }
  }
}

const scheduler = new Scheduler();

export type Mergeable<T> = {
  merge(next: T): T
};

export const isMergeable = (
  value: any
): value is Mergeable<any> => {
  return value != null && typeof value.merge === "function";
}

/** Merge a value if type implements merge, or else use last-write-wins */
export const merge = <T>(
  prev: T,
  next: T
): T => {
  if (isMergeable(prev)) {
    return prev.merge(next);
  }
  return next;
}

export type Cancel = () => void;

export type Cancellable = {
  cancel(): void;
}

export type AnyCell<T> = {
  content: T;
  subscribe(propagator: Task): Cancel;
}

export const isCell = (
  value: any
): value is AnyCell<any> => {
  return (
    value !== null &&
    Object.hasOwn(value, "content") &&
    typeof value.subscribe === "function"
  );
}

export const subscribeAll = (
  cells: Array<AnyCell<any>>,
  propagator: Task
): Cancel => {
  const cancels = cells.map(cell => cell.subscribe(propagator));
  return () => {
    for (const cancel of cancels) {
      cancel();
    }
  }
}

export class Cell<T> implements AnyCell<T> {
  #neighbors: Set<Task> = new Set();
  #content: T;

  constructor(initial: T) {
    this.#content = initial
  }

  get content() {
    return this.#content;
  }

  send(next: T) {
    const merged = merge(this.#content, next);
    if (this.#content !== merged) {
      this.#content = merged;
      scheduler.enqueue(this.#neighbors);
    }  
  }

  subscribe(propagator: Task) {
    this.#neighbors.add(propagator);
    scheduler.enqueue([propagator]);
    return () => {
      this.#neighbors.delete(propagator);
    }
  }
}

export const cell = <T>(initial: T) => new Cell(initial);

/** A read-only view over a cell */
export class CellView<T> implements AnyCell<T> {
  #cell: Cell<T>;

  constructor(cell: Cell<T>) {
    this.#cell = cell;
  }

  get content() {
    return this.#cell.content;
  }

  subscribe(propagator: Task) {
    return this.#cell.subscribe(propagator);
  }
}

export const cellView = <T>(cell: Cell<T>) => new CellView(cell);

export const constant = <T>(value: T): CellView<T> => cellView(cell(value));

export const getContent = <T>(
  cell: AnyCell<T>
): T => cell.content;

export const task = (poll: () => void) => ({poll});

const lift = (
  fn: (...args: Array<any>) => any,
) => (...cells: Array<AnyCell<any>>): Cancellable => {
  const output = cells.pop();
  if (!(output instanceof Cell)) {
    throw new TypeError("Last argument must be a writeable cell");
  }

  const lifted = task(() => {
    const result = fn(...cells.map(getContent))
    output.send(result);
  });

  scheduler.enqueue([lifted]);

  const cancel = subscribeAll(cells, lifted);

  return {cancel};
}

export const add = lift((a: number, b: number) => a + b); 
export const sub = lift((a: number, b: number) => a - b);
export const mul = lift((a: number, b: number) => a * b);
export const div = lift((a: number, b: number) => a / b);

export const sink = <T>(
  cell: AnyCell<T>,
  callback: (value: T) => void
) => {
  return cell.subscribe(task(() => {
    callback(cell.content);
  }));
}

const batched = (
  job: () => void,
  schedule: (job: () => void) => void
) => {
  let isScheduled = false;

  const perform = () => {
    isScheduled = false;
    job();
  }

  return () => {
    if (!isScheduled) {
      isScheduled = true;
      schedule(perform);
    }
  }
}

/** Render changes froma  cell on next frame */
export const render = <T>(
  cell: AnyCell<T>,
  callback: (value: T) => void
) => {
  const batchedRender = batched(
    () => callback(cell.content),
    requestAnimationFrame
  )
  return sink(cell, batchedRender);
}