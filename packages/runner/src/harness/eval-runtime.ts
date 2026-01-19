import {
  JsScript,
  MappedPosition,
  SourceMap,
  SourceMapParser,
} from "@commontools/js-compiler";

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

export class UnsafeEvalJsValue {
  private internals: IsolateInternals;
  private value: unknown;
  constructor(internals: IsolateInternals, value: unknown) {
    this.internals = internals;
    this.value = value;
  }
  invoke(...args: unknown[]): UnsafeEvalJsValue {
    if (typeof this.value !== "function") {
      throw new Error("Cannot invoke non function");
    }
    const func = this.value as (...args: unknown[]) => unknown;
    const result = this.internals.exec(() => func.apply(null, args));
    return new UnsafeEvalJsValue(this.internals, result);
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

  /**
   * Parse an error stack trace, mapping all positions back to original sources.
   */
  parseStack(stack: string): string {
    return this.sourceMaps.parse(stack);
  }

  /**
   * Clear accumulated source maps to release memory.
   */
  clear(): void {
    this.sourceMaps.clear();
  }
}

export class UnsafeEvalIsolate implements JsIsolate {
  private internals = new IsolateInternals();
  execute(
    input: string | JsScript,
  ): UnsafeEvalJsValue {
    const { js, filename, sourceMap } = typeof input === "string"
      ? { js: input, filename: "NO-NAME.js" }
      : input;

    if (filename && sourceMap) {
      this.internals.loadSourceMap(filename, sourceMap);
    }

    const result = this.internals.exec(() => eval(js));
    return new UnsafeEvalJsValue(this.internals, result);
  }

  // Make a new `UnsafeEvalJsValue` for this isolate from input.
  // Does not verify the providence of input.
  value<T>(value: T) {
    return new UnsafeEvalJsValue(this.internals, value);
  }

  mapPosition(
    filename: string,
    line: number,
    column: number,
  ): MappedPosition | null {
    return this.internals.mapPosition(filename, line, column);
  }

  /**
   * Parse an error stack trace, mapping all positions back to original sources.
   */
  parseStack(stack: string): string {
    return this.internals.parseStack(stack);
  }

  /**
   * Clear accumulated source maps and other state.
   * Call this when disposing the runtime to prevent memory leaks.
   */
  clear(): void {
    this.internals.clear();
  }
}

export class UnsafeEvalRuntime extends EventTarget implements JsRuntime {
  private isolateSingleton = new UnsafeEvalIsolate();
  constructor() {
    super();
  }

  getIsolate(_key: string): UnsafeEvalIsolate {
    return this.isolateSingleton;
  }

  mapPosition(
    filename: string,
    line: number,
    column: number,
  ): MappedPosition | null {
    return this.isolateSingleton.mapPosition(filename, line, column);
  }

  /**
   * Parse an error stack trace, mapping all positions back to original sources.
   */
  parseStack(stack: string): string {
    return this.isolateSingleton.parseStack(stack);
  }

  /**
   * Clear all isolate state. Call on dispose to release memory.
   */
  clear(): void {
    this.isolateSingleton.clear();
  }
}

export type { MappedPosition };
