import { JsScript, MappedPosition } from "@commontools/js-compiler";
import { IsolateInternals } from "./eval-runtime.ts";
import type { JsIsolate, JsRuntime, JsValue } from "./eval-runtime.ts";

// SES types (declared since we import dynamically)
declare const Compartment: new (
  globals?: object,
  modules?: object,
  options?: object,
) => CompartmentInstance;

interface CompartmentInstance {
  evaluate(code: string): unknown;
  globalThis: object;
}

export class SESJsValue implements JsValue {
  private internals: IsolateInternals;
  private value: unknown;
  constructor(internals: IsolateInternals, value: unknown) {
    this.internals = internals;
    this.value = value;
  }
  invoke(...args: unknown[]): SESJsValue {
    if (typeof this.value !== "function") {
      throw new Error("Cannot invoke non function");
    }
    const func = this.value as (...args: unknown[]) => unknown;
    const result = this.internals.exec(() => func.apply(null, args));
    return new SESJsValue(this.internals, result);
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

export class SESIsolate implements JsIsolate {
  private internals = new IsolateInternals();

  execute(input: string | JsScript): SESJsValue {
    const { js, filename, sourceMap } = typeof input === "string"
      ? { js: input, filename: "NO-NAME.js", sourceMap: undefined }
      : input;

    if (filename && sourceMap) {
      this.internals.loadSourceMap(filename, sourceMap);
    }

    const result = this.internals.exec(() => {
      const compartment = new Compartment({
        // The AMD bundle doesn't need special globals — it receives
        // runtimeExports via .invoke(runtimeExports) after execute().
        // We only need basic JS builtins which SES provides by default.
      });
      return compartment.evaluate(js);
    });
    return new SESJsValue(this.internals, result);
  }

  value<T>(value: T) {
    return new SESJsValue(this.internals, value);
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

export class SESRuntime extends EventTarget implements JsRuntime {
  private isolateSingleton = new SESIsolate();
  constructor() {
    super();
  }

  getIsolate(_key: string): SESIsolate {
    return this.isolateSingleton;
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
