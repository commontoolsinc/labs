import {
  JsScript,
  MappedPosition,
  SourceMap,
  SourceMapParser,
} from "@commonfabric/js-compiler";

export interface JsValue {
  invoke(...args: unknown[]): JsValue;
  inner(): unknown;
  asObject(): object;
  isObject(): boolean;
}

export interface JsIsolate {
  execute(js: string | JsScript): JsValue;
}

export interface JsRuntime extends EventTarget {
  getIsolate(key: string): JsIsolate;
}

export class LegacyEvalJsValue {
  private internals: IsolateInternals;
  private value: unknown;

  constructor(internals: IsolateInternals, value: unknown) {
    this.internals = internals;
    this.value = value;
  }

  invoke(...args: unknown[]): LegacyEvalJsValue {
    if (typeof this.value !== "function") {
      throw new Error("Cannot invoke non function");
    }
    const func = this.value as (...args: unknown[]) => unknown;
    const result = this.internals.exec(() => func.apply(null, args));
    return new LegacyEvalJsValue(this.internals, result);
  }

  inner(): unknown {
    return this.value;
  }

  asObject(): object {
    if (!this.isObject()) {
      throw new Error("Value is not an object");
    }
    return this.value as object;
  }

  isObject(): boolean {
    return !!(this.value && typeof this.value === "object");
  }
}

class IsolateInternals {
  private sourceMaps = new SourceMapParser();

  exec<T>(callback: () => T) {
    try {
      return callback();
    } catch (e: unknown) {
      const error = e as Error;
      materializeHostVisibleStack(error);
      if (error.stack) {
        error.stack = this.sourceMaps.parse(error.stack);
        throw error;
      }
      throw error;
    }
  }

  loadSourceMap(filename: string, sourceMap: SourceMap) {
    this.sourceMaps.load(filename, sourceMap);
  }

  mapPosition(
    filename: string,
    line: number,
    column: number,
  ): MappedPosition | null {
    return this.sourceMaps.mapPosition(filename, line, column);
  }

  parseStack(stack: string): string {
    return this.sourceMaps.parse(stack);
  }

  clear(): void {
    this.sourceMaps.clear();
  }
}

export class LegacyEvalIsolate implements JsIsolate {
  private internals = new IsolateInternals();

  execute(input: string | JsScript): LegacyEvalJsValue {
    const { js, filename, sourceMap } = typeof input === "string"
      ? { js: input, filename: "NO-NAME.js" }
      : input;

    if (filename && sourceMap) {
      this.internals.loadSourceMap(filename, sourceMap);
    }

    const result = this.internals.exec(() => eval(js));
    return new LegacyEvalJsValue(this.internals, result);
  }

  value<T>(value: T) {
    return new LegacyEvalJsValue(this.internals, value);
  }

  mapPosition(
    filename: string,
    line: number,
    column: number,
  ): MappedPosition | null {
    return this.internals.mapPosition(filename, line, column);
  }

  parseStack(stack: string): string {
    return this.internals.parseStack(stack);
  }

  clear(): void {
    this.internals.clear();
  }
}

export class LegacyEvalRuntime extends EventTarget implements JsRuntime {
  private isolateSingleton = new LegacyEvalIsolate();

  getIsolate(_key: string): LegacyEvalIsolate {
    return this.isolateSingleton;
  }

  invoke<T>(callback: () => T): T {
    return this.isolateSingleton.value(callback).invoke().inner() as T;
  }

  mapPosition(
    filename: string,
    line: number,
    column: number,
  ): MappedPosition | null {
    return this.isolateSingleton.mapPosition(filename, line, column);
  }

  parseStack(stack: string): string {
    return this.isolateSingleton.parseStack(stack);
  }

  clear(): void {
    this.isolateSingleton.clear();
  }
}

function materializeHostVisibleStack(error: Error): void {
  if (typeof error.stack === "string" && error.stack.length > 0) {
    return;
  }
  const getStackString = (globalThis as {
    getStackString?: (error: Error) => string;
  }).getStackString;
  if (typeof getStackString !== "function") {
    return;
  }
  const frames = getStackString(error);
  if (!frames) {
    return;
  }
  error.stack = `${error}${frames.startsWith("\n") ? frames : `\n${frames}`}`;
}

export type { MappedPosition };
