import {
  JsScript,
  MappedPosition,
  SourceMap,
  SourceMapParser,
} from "@commontools/js-compiler";
import "ses";

export interface SESRuntimeOptions {
  globals?: Record<string, unknown>;
  lockdown?: boolean;
}

export interface JsValue {
  invoke(...args: unknown[]): JsValue;
  inner(): unknown;
  asObject(): object;
  isObject(): boolean;
}

class SESInternals {
  private sourceMaps = new SourceMapParser();

  exec<T>(callback: () => T): T {
    try {
      return callback();
    } catch (e: unknown) {
      const error = e as Error;
      if (error.stack) {
        error.stack = this.sourceMaps.parse(error.stack);
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

class SESJsValue implements JsValue {
  constructor(
    private internals: SESInternals,
    private value: unknown,
  ) {}

  invoke(...args: unknown[]): SESJsValue {
    if (typeof this.value !== "function") {
      throw new Error("Cannot invoke non function");
    }
    const result = this.internals.exec(() =>
      Reflect.apply(
        this.value as (...args: unknown[]) => unknown,
        undefined,
        args,
      )
    );
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

export class SESIsolate {
  private internals = new SESInternals();
  private globals: Record<string, unknown>;

  constructor(private options: SESRuntimeOptions = {}) {
    this.globals = { ...(options.globals ?? {}) };
    ensureSESInitialized(!!options.lockdown);
  }

  execute(input: string | JsScript): SESJsValue {
    const { js, filename, sourceMap } = typeof input === "string"
      ? { js: input, filename: "NO-NAME.js" }
      : input;

    if (filename && sourceMap) {
      this.internals.loadSourceMap(filename, sourceMap);
    }

    const compartment = createCompartment(this.globals);
    const result = this.internals.exec(() => compartment.evaluate(js));
    return new SESJsValue(this.internals, result);
  }

  value<T>(value: T): SESJsValue {
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

export class SESRuntime extends EventTarget {
  private isolateSingleton: SESIsolate;

  constructor(private options: SESRuntimeOptions = {}) {
    super();
    this.isolateSingleton = new SESIsolate(options);
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

export function evaluateFunctionSourceInSES(
  source: string,
  options: SESRuntimeOptions = {},
): unknown {
  ensureSESInitialized(!!options.lockdown);
  const compartment = createCompartment(options.globals ?? {});
  return compartment.evaluate(`(${source})`);
}

let sesInitialized = false;

function ensureSESInitialized(lockdownEnabled: boolean): void {
  if (sesInitialized || !lockdownEnabled) {
    return;
  }
  const lockdownFn = (globalThis as { lockdown?: () => void }).lockdown;
  if (typeof lockdownFn !== "function") {
    throw new Error("SES lockdown() is unavailable");
  }
  lockdownFn();
  sesInitialized = true;
}

function createCompartment(globals: Record<string, unknown>) {
  const CompartmentCtor = (globalThis as {
    Compartment?: new (
      globals?: Record<string, unknown>,
    ) => { evaluate(source: string): unknown };
  }).Compartment;
  if (!CompartmentCtor) {
    throw new Error("SES Compartment is unavailable");
  }
  return new CompartmentCtor(globals);
}
