export const NAME = "$NAME";
export const UI = "$UI";

export function computed<T>(fn: () => T): T {
  return fn();
}

export function handler<Event, State>(
  implementation: (event: Event, state: State) => void,
): {
  (
    state: State,
  ): { implementation: (event: Event, state: State) => void; state: State };
  implementation: (event: Event, state: State) => void;
} {
  return Object.assign(
    (state: State) => ({ implementation, state }),
    { implementation },
  );
}

export function lift<T extends (...args: never[]) => unknown>(fn: T): T {
  return fn;
}

export function pattern<T>(definition: T): T {
  return definition;
}

export type Cell<T> = {
  get(): T;
  set(value: T): void;
};

export type Default<T, _Default> = T;
