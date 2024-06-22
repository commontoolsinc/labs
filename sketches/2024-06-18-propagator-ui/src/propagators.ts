export const config = {
  debug: false
}

export const debug = (...args: Array<any>) => {
  if (config.debug) {
    console.debug(...args);
  }
}

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
  get(): T;
  connect(task: Task): Cancellable;
}

export const isCell = (
  value: any
): value is AnyCell<any> => {
  return (
    value !== null &&
    typeof value.get === "function" &&
    typeof value.subscribe === "function"
  );
}

/**
 * Create a bag to hold cancel functions
 * Returns a cancellable.
 */
export const cancellable = (
  ...cancellables: Array<Cancellable>
): Cancellable => {
  const cancel = () => {
    for (const cancellable of cancellables) {
      cancellable.cancel();
    }
  }
  return {cancel};
};

export const connectAll = (
  cells: Array<AnyCell<any>>,
  task: Task
): Cancellable => {
  const cancels = cells.map(cell => cell.connect(task));
  return cancellable(...cancels);
}

let _cid = 0;

/**
 * Create a unique client ID using a client-side counter.
 * DO NOT persist cids. They are only unique for the script lifetime.
 */
export const cid = () => `cid${_cid++}`;

const noOp = () => {};

const batcher = (
  schedule: (job: () => void) => void
) => {
  const id = cid()
  let scheduledJob = noOp;
  let isScheduled = false;

  const perform = () => {
    isScheduled = false;
    debug(`[batcher#${id}]`, "performing job");
    scheduledJob();
  }

  return (job: () => void) => {
    scheduledJob = job;
    debug(`[batcher#${id}]`, "set job");
    if (!isScheduled) {
      isScheduled = true;
      debug(`[batcher#${id}]`, "scheduling job");
      schedule(perform);
    }
  }
}

const taskBatcher = () => batcher(queueMicrotask);

export class Cell<T> implements AnyCell<T> {
  cid = cid();
  #batch = taskBatcher();
  #neighbors: Set<Task> = new Set();
  #content: T;

  constructor(initial: T) {
    this.#content = initial
    debug(`[cell#${this.cid}]`, 'created', this.#content);
  }

  get() {
    return this.#content;
  }

  send(next: T) {
    debug(`[cell#${this.cid}]`, 'send', next);
    this.#batch(() => {
      const merged = merge(this.#content, next);
      if (this.#content !== merged) {
        this.#content = merged;
        debug(`[cell#${this.cid}]`, 'updated', this.#content);
        scheduler.enqueue(this.#neighbors);
      }
    })
  }

  connect(task: Task) {
    this.#neighbors.add(task);
    scheduler.enqueue([task]);
    debug(`[cell#${this.cid}]`, 'add neighbor');
    const cancel = () => {
      debug(`[cell#${this.cid}]`, 'cancel');
      this.#neighbors.delete(task);
    }
    return {cancel};
  }
}

export const cell = <T>(initial: T) => new Cell(initial);

/** A read-only view over a cell */
export class CellView<T> implements AnyCell<T> {
  cid = cid();
  #cell: Cell<T>;

  constructor(cell: Cell<T>) {
    this.#cell = cell;
  }

  get() {
    return this.#cell.get();
  }

  connect(propagator: Task) {
    return this.#cell.connect(propagator);
  }
}

export const cellView = <T>(cell: Cell<T>) => new CellView(cell);

export const constant = <T>(value: T): CellView<T> => cellView(cell(value));

export const getContent = <T>(
  cell: AnyCell<T>
): T => cell.get();

export const task = (poll: () => void) => ({poll});

export type AnyPropagator = Cancellable & {
  cid: string;
}

const lift = (
  fn: (...args: Array<any>) => any,
) => (
  ...cells: Array<AnyCell<any>>
): AnyPropagator => {
  const output = cells.pop();
  if (!(output instanceof Cell)) {
    throw new TypeError("Last argument must be a writeable cell");
  }

  const lifted = task(() => {
    const result = fn(...cells.map(getContent))
    output.send(result);
  });

  scheduler.enqueue([lifted]);

  const {cancel} = connectAll(cells, lifted);

  return {
    cid: cid(),
    cancel
  };
}

export const add = lift((a: number, b: number) => a + b); 
export const sub = lift((a: number, b: number) => a - b);
export const mul = lift((a: number, b: number) => a * b);
export const div = lift((a: number, b: number) => a / b);

/** Call a callback whenever cell contents changes */
export const sink = <T>(
  cell: AnyCell<T>,
  callback: (value: T) => void
) => {
  return cell.connect(task(() => {
    callback(cell.get());
  }));
}

const frameBatcher = () => batcher(requestAnimationFrame);

/** Render changes froma  cell on next frame */
export const render = <T>(
  cell: AnyCell<T>,
  callback: (value: T) => void
) => {
  const batch = frameBatcher();
  const perform = () => callback(cell.get())
  return sink(cell, () => batch(perform));
}