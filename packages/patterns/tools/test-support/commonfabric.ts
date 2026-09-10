export type Default<T> = T;
export type BuiltInLLMMessage = {
  role: string;
  content: Array<Record<string, unknown>>;
};
export declare const CELL_LIKE: unique symbol;
export type CellLike<T = unknown> = T;
export type JSXElement = unknown;
export type JSONSchema = boolean | Record<string, unknown>;
export type RenderNode = unknown;
export type Stream<T = unknown> = unknown;
// `packages/html/src/jsx.d.ts` imports this beside `Stream`; this mirror must
// export every name that file pulls from `commonfabric` or pattern tests fail
// to type-check.
export type AnyStream = unknown;

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
