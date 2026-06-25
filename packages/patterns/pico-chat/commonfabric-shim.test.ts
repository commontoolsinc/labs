export const NAME = "$NAME";
export const UI = "$UI";
export const Stream = Symbol("Stream");
export const Default = Symbol("Default");

export type Default<T, _Value extends T = T> = T;
export type PerSpace<T> = T;
export type PerUser<T> = T;
export type Stream<T> = { send(event: T): void };
export type VNode = unknown;

export class TestWritable<T> {
  #value: T;

  constructor(value: T) {
    this.#value = value;
  }

  get(): T {
    return this.#value;
  }

  set(value: T): void {
    this.#value = value;
  }

  push(value: T extends Array<infer Item> ? Item : never): void {
    if (!Array.isArray(this.#value)) {
      throw new TypeError("Cannot push into a non-array cell");
    }

    this.#value.push(value);
  }

  get length(): number {
    return Array.isArray(this.#value) ? this.#value.length : 0;
  }

  [Symbol.iterator](): IterableIterator<unknown> {
    if (!Array.isArray(this.#value)) {
      return [][Symbol.iterator]();
    }

    return this.#value[Symbol.iterator]();
  }
}

export type Writable<T> = TestWritable<T>;

export const Writable = {
  of<T>(value: T): TestWritable<T> {
    return toWritable(value);
  },
};

function isWritable<T>(value: unknown): value is TestWritable<T> {
  return value instanceof TestWritable ||
    (
      typeof value === "object" &&
      value !== null &&
      "get" in value &&
      "set" in value
    );
}

function toWritable<T>(value: T | TestWritable<T>): TestWritable<T> {
  return isWritable<T>(value) ? value : new TestWritable(value);
}

function wrapInput<T extends Record<string, unknown>>(input: T): T {
  return Object.fromEntries(
    Object.entries(input).map(([key, value]) => [key, toWritable(value)]),
  ) as T;
}

export function computed<T>(fn: () => T): T {
  return fn();
}

export function handler<Event, State>(
  implementation: (event: Event, state: State) => void,
): (state: State) => { send(event: Event): void } {
  return (state: State) => ({
    send(event: Event): void {
      implementation(event, state);
    },
  });
}

export function pattern<Input extends Record<string, unknown>, Output>(
  definition: (input: Input) => Output,
): (input: Input) => Output {
  return (input: Input) => definition(wrapInput(input));
}
