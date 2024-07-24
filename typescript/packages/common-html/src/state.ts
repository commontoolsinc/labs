/** A one-to-many typed event publisher */
export class Publisher<T> {
  #listeners = new Set<(value: T) => void>();

  send(value: T) {
    for (const listener of this.#listeners) {
      listener(value);
    }
  }

  sink(callback: (value: T) => void) {
    const listeners = this.#listeners;
    listeners.add(callback);
    return () => {
      listeners.delete(callback);
    };
  }
}

export class State<T> {
  #publisher = new Publisher<T>();
  #state: T;

  constructor(value: T) {
    this.#state = value;
  }

  get() {
    return this.#state;
  }

  send(value: T) {
    this.#state = value;
    this.#publisher.send(value);
  }

  sink(callback: (value: T) => void) {
    callback(this.#state);
    return this.#publisher.sink(callback);
  }

  key<K extends keyof T>(key: K) {
    return new ScopedState(this, (value) => value[key]);
  }
}

/** A simple reactive state cell without any scheduling */
export const state = <T>(value: T) => new State(value);

export default state;

/**
 * A scoped cell that represents some transformation of a state.
 * ScopedState is a "cold" reactive value. It only does work when you subscribe
 * to it with sink. Each sink performs computed transformation of the source
 * state separately, and returns a cancel function to unsubscribe that
 * particular sink. There are no intermediate subscriptions to cancel.
 */
export class ScopedState<T, U> {
  #source: State<T>;
  #transform: (value: T) => U;

  constructor(source: State<T>, transform: (value: T) => U) {
    this.#transform = transform;
    this.#source = source;
  }

  get(): U {
    return this.#transform(this.#source.get());
  }

  sink(callback: (value: U) => void) {
    let state: U | null = null;
    return this.#source.sink((value) => {
      const next = this.#transform(value);
      if (state !== next) {
        state = next;
        callback(next);
      }
    });
  }

  key<K extends keyof U>(key: K) {
    return new ScopedState<T, U[K]>(this.#source, (value) => {
      const scoped = this.#transform(value);
      return scoped[key];
    });
  }
}

/** A simple reactive event stream without any scheduling */
export const stream = <T>() => new Publisher<T>();
