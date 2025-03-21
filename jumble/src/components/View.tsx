import { JSX, useCallback, useEffect, useRef, useState } from "react";

export interface Behavior<Model, Command> {
  init(): { state: Model; fx?: Effect<Command>[] };
  update(
    model: Model,
    command: Command,
  ): { state: Model; fx?: Effect<Command>[] };

  view(model: Model, controller: Controller<Command>): JSX.Element;
}

export interface Effect<Command> {
  (): Promise<Command>;
}

export interface Controller<Command> {
  perform(effect: Effect<Command>): void;

  dispatch(command: Command): () => void;
}

class Process<Model, Command> implements Controller<Command> {
  state: Model;
  view: JSX.Element;

  constructor(
    public behavior: Behavior<Model, Command>,
    public advance: (self: [Process<Model, Command>]) => void,
  ) {
    const { state, fx } = behavior.init();
    this.state = state;
    this.view = behavior.view(state, this);

    this.enqueue(fx ?? []);
  }

  async perform(effect: Effect<Command>) {
    const command = await effect();
    const { state, fx } = this.behavior.update(this.state, command);
    this.state = state;
    this.view = this.behavior.view(this.state, this);
    this.enqueue(fx ?? []);

    this.advance([this]);
  }

  enqueue(effects: Effect<Command>[]) {
    for (const effect of effects) {
      this.perform(effect);
    }
  }

  dispatch(command: Command) {
    return () => this.perform(async () => command);
  }

  terminate() {
  }
}

/**
 * Define react component as state machine.
 *
 * @example
 * ```js
 * const Counter = View({
 *   init() {
 *    return { state: { count: 0 } };
 *   },
 *   update({ count }: { count: number }, command: "inc" | "dec") {
 *     switch (command) {
 *       case "inc":
 *         return { state: { count: count + 1 } };
 *       case "dec":
 *         return { state: { count: count + 1 } };
 *       default:
 *         return { state: { count } };
 *     }
 *   },
 *   view(state, controller) {
 *     return <button onClick={controller.dispatch("inc")}>{state.count}</button>;
 *   },
 * });
 * ```
 *
 * Then you can use it as react component as
 *
 * ```js
 * <Counter />
 * ```
 */
export default <Model, Command>(behavior: Behavior<Model, Command>) => {
  return function View() {
    const [process, advance] = useState<[Process<Model, Command>]>();

    useEffect(() => {
      const process = new Process(behavior, advance);
      advance([process]);

      return () => process.terminate();
    }, []);

    return process?.[0]?.view ?? null;
  };
};
