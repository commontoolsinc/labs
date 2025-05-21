import { ExecutableJs, JsIsolate, JsRuntime } from "./interface.ts";
import { SourceMapParser } from "./source-map.ts";

export class UnsafeEvalJsValue {
  private value: any;
  constructor(value: any) {
    this.value = value;
  }
  invoke(...args: any[]): UnsafeEvalJsValue {
    if (typeof this.value !== "function") {
      throw new Error("Cannot invoke non function");
    }
    return new UnsafeEvalJsValue(this.value.apply(null, args));
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

export class UnsafeEvalIsolate implements JsIsolate {
  private sourceMaps = new SourceMapParser();
  execute(
    input: string | ExecutableJs,
  ): UnsafeEvalJsValue {
    const { js, filename, sourceMap } = typeof input === "string"
      ? { js: input, filename: "NO-NAME.tsx" }
      : input;

    if (filename && sourceMap) {
      this.sourceMaps.load(filename, sourceMap);
    }
    try {
      return new UnsafeEvalJsValue(eval(js));
    } catch (e: any) {
      const error = e as Error;
      if (error.stack) {
        const result = this.sourceMaps.parse(error.stack);
        throw new Error(result);
      }
      throw error;
    }
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
