export type Default<T> = T;
export declare const CELL_LIKE: unique symbol;
export type CellLike<T = unknown> = T;
export type JSXElement = unknown;
export type RenderNode = unknown;
export type Stream<T = unknown> = unknown;

export interface PatternEnvironment {
  readonly apiUrl: URL;
}

export interface Writable<T> {
  get(): T;
  update(next: T): void;
}

let patternEnvironment: PatternEnvironment = {
  apiUrl: new URL("https://commonfabric.test/"),
};

export function getPatternEnvironment(): PatternEnvironment {
  return patternEnvironment;
}

export function setTestPatternEnvironment(
  environment: PatternEnvironment,
): void {
  patternEnvironment = environment;
}
