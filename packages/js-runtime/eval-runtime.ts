import { JsIsolate, JsRuntime, JsScript, SourceMap } from "./interface.ts";
import { SourceMapParser } from "./source-map.ts";

export class UnsafeEvalJsValue {
  private internals: IsolateInternals;
  private value: any;
  constructor(internals: IsolateInternals, value: any) {
    this.internals = internals;
    this.value = value;
  }
  invoke(...args: any[]): UnsafeEvalJsValue {
    if (typeof this.value !== "function") {
      throw new Error("Cannot invoke non function");
    }
    const result = this.internals.exec(() => this.value.apply(null, args));
    return new UnsafeEvalJsValue(this.internals, result);
  }
  inner(): any {
    return this.value;
  }
  asObject(): object {
    if (!this.isObject()) {
      throw new Error("Value is not an object");
    }
    return this.value as object;
  }
  isObject(): boolean {
    return this.value && typeof this.value === "object";
  }
}

class IsolateInternals {
  private sourceMaps = new SourceMapParser();

  exec<T>(callback: () => T) {
    try {
      return callback();
    } catch (e: any) {
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
