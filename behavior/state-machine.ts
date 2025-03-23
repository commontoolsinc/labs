// deno-lint-ignore-file require-yield

class Perform<Command> {
  constructor(public execute: () => Promise<Command>) {
  }
}

class Spawn<Effect, Ok = void> {
  constructor(
    public work: () => Task<Effect, Ok>,
  ) {
  }
}

export type FX<Command> =
  | Send<Command>
  | Spawn<Send<Command> | Perform<Command> | Wait>;

export interface Behavior<Model, Command> {
  init(): Task<FX<Command>, Model>;

  update: (model: Model, command: Command) => Task<FX<Command>, Model>;
}

export interface Effect<Command> {
  (): Promise<Command>;
}

export interface Controller<Command> {
  dispatch(command: Command): () => void;
}

export interface Subscriber<Model, Command, View> {
  (self: Service<Model, Command>): View;
}

function* test() {
  yield Promise.resolve();
}

export interface Task<Command, Ok = InferReturn<Command>> {
  [Symbol.iterator](): Job<Command, Ok>;
}

export interface Job<Command, Ok> {
  throw(error: InferError<Command>): Step<Ok, Command>;
  return(ok: Ok): Step<Ok, Command>;
  next(value: void): Step<Ok, Command>;
  [Symbol.iterator](): Job<Command, Ok>;
}

export type InferError<Command> = Command extends Throw<infer Error> ? Error
  : never;

export type InferReturn<Command> = Command extends Return<infer Ok> ? Ok
  : never;
export type Step<
  Ok extends unknown,
  Command extends unknown,
> = IteratorResult<Command, Ok>;

class Throw<Failure extends Error> {
  constructor(public error: Failure) {}
}

class Wait<T extends unknown = unknown> {
  constructor(public promise: Promise<T>) {
  }
}

type T = Generator<T>;

export const wait = function* <T>(
  promise: Promise<T>,
): Task<Wait<T>, T> {
  const result = yield new Wait(promise);
  return result as T;
};

export const sleep = function* (ms: number = 0): Task<Wait<void>, void> {
  yield* wait(new Promise((wake) => setTimeout(wake, ms)));
};

export const spawn = function* <Command>(
  work: () => Task<Command, void>,
): Task<Spawn<Command>, Spawn<Command>> {
  const spawn = new Spawn(work);
  yield spawn;
  return spawn;
};

export const fork = <Command>(task: Task<Command, void>) => spawn(() => task);

export const send = function* <
  Command extends string | number | boolean | null | object,
>(
  command: Command,
): Task<Send<Command>, void> {
  yield new Send(command);
};

class Return<Ok extends unknown> {
  constructor(public ok: Ok) {}
}

class Send<Command> {
  constructor(public command: Command) {}
}

export interface Execution<
  Ok extends unknown,
  Command extends unknown,
> {
  next(): IterableIterator<Command, Ok>;
  [Symbol.iterator](): Execution<Ok, Command>;
}

export const service = <Model, Command>(behavior: Behavior<Model, Command>) =>
  new Service(behavior);

export type InferSend<Effect> = Effect extends Send<infer Command> ? Command
  : never;

class Service<Model, Command> {
  state!: Model;

  subscribers: Set<Subscriber<Model, Command, unknown>> | undefined;
  inbox: Command[] = [];
  queue: FX<Command>[] = [];

  work: Job<Send<Command> | Perform<Command> | Wait, void>[] = [];
  idle: boolean = true;

  constructor(
    public behavior: Behavior<Model, Command>,
  ) {
  }

  execute(command: Command) {
    this.inbox.push(command);
    this.wake();
  }

  wake() {
    if (this.idle) {
      this.idle = false;
      while (this.inbox.length > 0 || this.queue.length > 0) {
        for (const command of this.inbox.splice(0)) {
          // Initialize the state if it doesn't exist yet
          if (!this.state) {
            this.advance(this.behavior.init());
          }
          
          this.state = this.advance(this.behavior.update(this.state, command));
        }

        for (const effect of this.queue.splice(0)) {
          if (effect instanceof Send) {
            this.inbox.push(effect.command);
          } else if (effect instanceof Spawn) {
            this.spawn(effect);
          } else if (effect instanceof Wait) {
            // Handle Wait directly
            this.handleWait(effect);
          } else if (effect && typeof effect === 'object' && 'execute' in effect && typeof effect.execute === 'function') {
            // Handle custom effect objects with execute method (like FetchEffect)
            this.handleCustomEffect(effect);
          }
        }
      }

      this.idle = true;
      this.notify();
    }
  }
  
  async handleWait(effect: Wait) {
    try {
      const result = await effect.promise;
      this.inbox.push(result as unknown as Command);
    } catch (error) {
      console.error("Error in wait effect:", error);
    }
  }
  
  async handleCustomEffect(effect: any) {
    try {
      if (typeof effect.execute === 'function') {
        const result = await effect.execute();
        this.inbox.push(result as Command);
      }
    } catch (error) {
      console.error("Error in custom effect:", error);
    }
  }

  async spawn(effect: Spawn<Wait | Send<Command> | Perform<Command>>) {
    const work = effect.work()[Symbol.iterator]();
    let state = undefined;
    while (true) {
      const step = work.next(state as void);
      if (step.done) {
        return step.value;
      } else {
        const { value } = step;
        if (value instanceof Send) {
          this.execute(value.command);
        } else if (value instanceof Wait) {
          try {
            state = await value.promise;
          } catch (error) {
            console.error("Error in spawned wait:", error);
            work.throw(error);
          }
        } else if (value && typeof value === 'object' && 'execute' in value && typeof value.execute === 'function') {
          try {
            state = await value.execute();
          } catch (error) {
            console.error("Error in spawned custom effect:", error);
            work.throw(error);
          }
        } else {
          try {
            state = await value.execute();
          } catch (error) {
            console.error("Error in spawned effect:", error);
            work.throw(error);
          }
        }
      }
    }
  }

  advance(task: Task<FX<Command>, Model>) {
    const work = task[Symbol.iterator]();
    while (true) {
      try {
        const step = work.next();
        if (step.done) {
          this.state = step.value;
          return this.state;
        } else {
          const effect = step.value;
          if (effect instanceof Send) {
            this.queue.push(effect);
          } else if (effect instanceof Spawn) {
            this.queue.push(effect);
          } else if (effect instanceof Wait) {
            this.queue.push(effect);
          } else if (effect && typeof effect === 'object' && 'execute' in effect && typeof effect.execute === 'function') {
            // Handle custom effect objects with execute method (like FetchEffect)
            this.queue.push(effect as any);
          } else if (effect && typeof effect === 'object' && 'type' in effect) {
            // Handle command objects directly
            this.inbox.push(effect as unknown as Command);
          } else {
            console.error("Unknown effect type:", effect);
          }
        }
      } catch (error) {
        console.error("Error in advance:", error);
        throw error;
      }
    }
  }

  notify() {
    for (const subscriber of this.subscribers ?? []) {
      subscriber(this);
    }
  }

  dispatch(command: Command) {
    return () => this.execute(command);
  }

  terminate() {
  }

  subscribe<View>(subscriber: Subscriber<Model, Command, View>) {
    if (!this.subscribers) {
      this.subscribers = new Set([subscriber]);
      this.advance(this.behavior.init());
      this.wake();
    } else {
      this.subscribers.add(subscriber);
    }
  }

  unsubscribe<View>(subscriber: Subscriber<Model, Command, View>) {
    if (this.subscribers) {
      this.subscribers.delete(subscriber);
    }
  }
}

export { Service as Process };
export default Service;