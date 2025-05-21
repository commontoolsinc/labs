import { Recipe } from "@commontools/builder";
import { type RawSourceMap } from "source-map-js";

export class CompilerError extends Error {
  override name = "CompilerError";
  constructor(message: string) {
    super(message);
  }
}

export interface JsValue {
  invoke(...args: any[]): JsValue;
  inner(): any;
  asObject(): object;
  isObject(): boolean;
}

// A JS runtime context.
export interface JsIsolate {
  // Execute `js` within this `JsIsolate`, returning the value.
  execute(js: string | ExecutableJs): JsValue;
}

// A `JsRuntime` can host several `JsIsolate`s, capable
// of executing JavaScript.
export interface JsRuntime extends EventTarget {
  // Get `JsIsolate` by `key`.
  getIsolate(key: string): JsIsolate;
}

// A map of filename to typescript source.
export interface TsArtifact {
  entry: string;
  // Keys are an absolute FS-like path
  // starting with `/` and must contain
  // one `/main.ts` or `/main.tsx` file.
  files: Record<string, string>;
}

// A transformed (TypeScript) module.
export interface JsModule {
  // The generated JS from the source TS.
  contents: string;
  // Input source filename.
  originalFilename: string;
  // The generated source map definition.
  sourceMap: SourceMap;
  // The generated .d.ts source.
  // Not currently generated, but typechecked
  typesSrc?: string;
}

export const isJsModule = (value: unknown): value is JsModule =>
  !!(typeof value === "object" && value &&
      "originalFilename" in value &&
      typeof value.originalFilename === "string" &&
      "contents" in value && typeof value.contents === "string" &&
      "sourceMap" in value && typeof value.sourceMap === "object" &&
      value.sourceMap &&
      "typesSrc" in value
    ? typeof value.typesSrc === "string"
    : true);

// A collection of JS modules with an entry point.
export interface JsArtifact {
  entry: string;
  modules: Record<string, JsModule>;
}

// A ready-to-execute string of JavaScript,
// with optional metadata.
export interface ExecutableJs {
  js: string;
  sourceMap?: SourceMap;
  filename?: string;
}

// An interface for transforming a source file bundle `T` into `JsArtifact`s.
export interface Compiler<T> {
  // Compiles `source` into `JsArtifact`.
  compile(source: T): JsArtifact;
}

export interface SourceMap extends RawSourceMap {}

export const isSourceMap = (value: unknown): value is SourceMap =>
  !!(value && typeof value === "object" &&
    "version" in value && value.version === "3" &&
    "file" in value && typeof value.file === "string" &&
    "sourceRoot" in value && typeof value.sourceRoot === "string" &&
    "sources" in value && Array.isArray(value.sources) &&
    "names" in value && Array.isArray(value.names) &&
    "mappings" in value && typeof value.mappings === "string");
