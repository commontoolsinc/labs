import { NonEmptyKeyPath, path } from "./path.js";
import { ReactiveValue } from "./reactive.js";

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

class State<T> {
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

  path(keyPath: NonEmptyKeyPath) {
    return scope(this, (value) => path(value, keyPath));
  }
}

/** A simple reactive state cell without any scheduling */
export const state = <T>(value: T) => new State(value);

/**
 * A scoped cell that represents some transformation of a state.
 * ScopedState is a "cold" reactive value. It only does work when you subscribe
 * to it with sink. Each sink performs computed transformation of the source
 * state and returns a cancel function to unsubscribe.
 */
export class ScopedState<T, U> {
  #source: ReactiveValue<T>;
  #transform: (value: T) => U;

  constructor(source: ReactiveValue<T>, transform: (value: T) => U) {
    this.#transform = transform;
    this.#source = source;
  }

  get() {
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

  path(keyPath: NonEmptyKeyPath) {
    return scope(this, (value) => path(value, keyPath));
  }
}

export const scope = <T, U>(
  source: ReactiveValue<T>,
  transform: (value: T) => U,
) => new ScopedState(source, transform);

/** A simple reactive event stream without any scheduling */
export const stream = <T>() => new Publisher<T>();

export default state;
