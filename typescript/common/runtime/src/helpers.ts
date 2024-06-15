export type ElementUnion<T extends readonly any[]> = T[number];

class Logger {
  constructor(readonly prefix: string) {}

  log(...args: any[]) {
    console.log(`[${this.prefix}]`, ...args);
  }

  warn(...args: any[]) {
    console.warn(`[${this.prefix}]`, ...args);
  }

  error(...args: any[]) {
    console.error(`[${this.prefix}]`, ...args);
  }
}

export const logger = new Logger('common-runtime');

export type EventMap<Events> = {
  [E in keyof Events]: never;
};

export const assertNever = (value: never): never => {
  throw new Error(`Unhandled value: ${value}`);
};

export const downcast = <T>(value: unknown): T => {
  return value as T;
};

export const isEvent = <AllEvents, Event extends AllEvents>(
  event: AllEvents,
  check: Event
): event is Event => {
  return event === check;
};

export const isError = (candidate: unknown): candidate is { error: string } => {
  return (
    candidate != null &&
    typeof candidate == 'object' &&
    'error' in candidate &&
    typeof candidate.error != 'undefined'
  );
};

export const throwIfError = (
  candidate: unknown
): candidate is { error: string } => {
  if (isError(candidate)) {
    throw new Error(candidate.error);
  }
  return false;
};
