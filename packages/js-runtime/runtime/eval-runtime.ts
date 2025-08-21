import { JsIsolate, JsRuntime, JsScript, SourceMap } from "../interface.ts";
import { SourceMapParser } from "../source-map.ts";

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
}

export class UnsafeEvalRuntime extends EventTarget implements JsRuntime {
  private isolateSingleton = new UnsafeEvalIsolate();
  constructor() {
    super();
  }

  getIsolate(key: string): UnsafeEvalIsolate {
    return this.isolateSingleton;
  }
}
