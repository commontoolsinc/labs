import { type RawSourceMap } from "source-map-js";

// A reference to a runtime value from a `JsIsolate`.
export interface JsValue {
  invoke(...args: unknown[]): JsValue;
  inner(): unknown;
  asObject(): object;
  isObject(): boolean;
}

// A JS runtime context.
export interface JsIsolate {
  // Execute `js` within this `JsIsolate`, returning the value.
  execute(js: string | JsScript): JsValue;
}

// A `JsRuntime` can host several `JsIsolate`s, capable
// of executing JavaScript.
export interface JsRuntime extends EventTarget {
  // Get `JsIsolate` by `key`.
  getIsolate(key: string): JsIsolate;
}

export interface Source {
  name: string;
  contents: string;
}

export interface TsModuleSource extends Source {
  name: `${string}.ts` | `${string}.tsx`;
  contents: string;
}

export interface JsModuleSource extends Source {
  name: `${string}.js` | `${string}.jsx`;
  contents: string;
}

export interface TypeDefSource extends Source {
  name: `${string}.d.ts`;
  contents: string;
}

export interface Compiler<T> {
  compile(input: Program | ProgramResolver, options: T): JsScript;
}

// A program's entry point with a resolver to
// resolve other sources used in the program.
export interface ProgramResolver {
  entry(): Source;
  resolveSource(identifier: string): Promise<Source | undefined>;
}

// An entry point and its sources for a program.
export interface Program {
  entry: string;
  files: Source[];
}

export function isProgram(value: unknown): value is Program {
  return !!value && typeof value === "object" && "entry" in value &&
    typeof value.entry === "string" && "files" in value &&
    Array.isArray(value.files);
}

// A ready-to-execute string of JavaScript,
// with optional metadata.
export interface JsScript {
  js: string;
  sourceMap?: SourceMap;
  filename?: string;
}

export interface SourceMap extends RawSourceMap {}
