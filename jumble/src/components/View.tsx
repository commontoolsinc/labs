// deno-lint-ignore-file require-yield
import { JSX, useCallback, useEffect, useRef, useState } from "react";

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

export const wait = function* <T,>(
  promise: Promise<T>,
): Task<Wait<T>, T> {
  const result = yield new Wait(promise);
  return result as T;
};

export const sleep = function* (ms: number = 0): Task<Wait<void>, void> {
  yield* wait(new Promise((wake) => setTimeout(wake, ms)));
};

export const spawn = function* <Command,>(
  work: () => Task<Command, void>,
): Task<Spawn<Command>, Spawn<Command>> {
  const spawn = new Spawn(work);
  yield spawn;
  return spawn;
};

export const fork = <Command,>(task: Task<Command, void>) => spawn(() => task);

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
          this.state = this.advance(this.behavior.update(this.state, command));
        }

        for (const effect of this.queue.splice(0)) {
          if (effect instanceof Send) {
            this.inbox.push(effect.command);
          } else if (effect instanceof Spawn) {
            this.spawn(effect);
          }
        }
      }

      this.idle = true;
      this.notify();
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
          state = await value.promise;
        } else {
          state = await value.execute();
        }
      }
    }
  }

  advance(task: Task<FX<Command>, Model>) {
    const work = task[Symbol.iterator]();
    while (true) {
      const step = work.next();
      if (step.done) {
        this.state = step.value;
        return this.state;
      } else {
        this.queue.push(step.value);
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
  render<View>(view: (state: Model, controller: Controller<Command>) => View) {
    const [process, advance] = useState<[Service<Model, Command>]>();
    const [ui, setUI] = useState<View | null>(null);

    useEffect(
      () =>
        this.subscribe((process) => {
          console.log("advance");
          advance([process]);
        }),
      [],
    );

    useEffect(() => {
      console.log("render");
      const [task] = process ?? [];
      if (task) {
        setUI(view(task.state, task));
      }
    }, [process]);

    return ui;
  }

  View<View>(view: (state: Model, controller: Controller<Command>) => View) {
    return () => this.render(view);
  }
}

// /**
//  * Define react component as state machine.
//  *
//  * @example
//  * ```js
//  * const Counter = View({
//  *   init() {
//  *    return { state: { count: 0 } };
//  *   },
//  *   update({ count }: { count: number }, command: "inc" | "dec") {
//  *     switch (command) {
//  *       case "inc":
//  *         return { state: { count: count + 1 } };
//  *       case "dec":
//  *         return { state: { count: count + 1 } };
//  *       default:
//  *         return { state: { count } };
//  *     }
//  *   },
//  *   view(state, controller) {
//  *     return <button onClick={controller.dispatch("inc")}>{state.count}</button>;
//  *   },
//  * });
//  * ```
//  *
//  * Then you can use it as react component as
//  *
//  * ```js
//  * <Counter />
//  * ```
//  */
// export default <Model, Command>(behavior: Behavior<Model, Command>) => {
//   return function View() {
//     const [process, advance] = useState<[Process<Model, Command>]>();

//     useEffect(() => {
//       const process = new Process(behavior, advance);
//       advance([process]);

//       return () => process.terminate();
//     }, []);

//     return process?.[0]?.view ?? null;
//   };
// };

export { Service as Process };
export default Service;
