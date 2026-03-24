import {
  JsScript,
  MappedPosition,
  SourceMap,
  SourceMapParser,
} from "@commontools/js-compiler";
import "ses";
import { createCallbackCompartmentGlobals } from "./compartment-globals.ts";
import { hardenVerifiedFunction } from "./function-hardening.ts";

export interface SESRuntimeOptions {
  globals?: Record<string, unknown>;
  lockdown?: boolean;
}

interface SESLockdownOptions {
  errorTaming: "safe" | "unsafe" | "unsafe-debug";
  errorTrapping: "platform" | "none" | "report" | "abort" | "exit";
  reporting: "platform" | "console" | "none";
  unhandledRejectionTrapping: "none" | "report";
  regExpTaming: "safe" | "unsafe";
  localeTaming: "safe" | "unsafe";
  consoleTaming: "unsafe" | "safe";
  overrideTaming: "moderate" | "min" | "severe";
  stackFiltering: "concise" | "omit-frames" | "shorten-paths" | "verbose";
  domainTaming: "safe" | "unsafe";
  evalTaming: "safe-eval" | "unsafe-eval" | "no-eval";
  overrideDebug: string[];
  legacyRegeneratorRuntimeTaming: "safe" | "unsafe-ignore";
  __hardenTaming__: "safe" | "unsafe";
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
      const result = callback();
      if (isPromiseLike(result)) {
        return result.catch((error: unknown) => {
          throw this.mapThrownError(error);
        }) as T;
      }
      return result;
    } catch (e: unknown) {
      throw this.mapThrownError(e);
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
    return sanitizeInternalFrames(this.sourceMaps.parse(stack));
  }

  clear(): void {
    this.sourceMaps.clear();
  }

  private mapThrownError(error: unknown): unknown {
    if (!(error instanceof Error)) {
      return error;
    }
    materializeHostVisibleStack(error);
    if (error.stack) {
      error.stack = this.parseStack(error.stack);
    }
    return error;
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
  try {
    return compartment.evaluate(`(${source})`);
  } catch (e: unknown) {
    const error = e as Error;
    materializeHostVisibleStack(error);
    throw error;
  }
}

export function evaluateCallbackSourceInSES(
  source: string,
): unknown {
  const value = evaluateFunctionSourceInSES(source, {
    globals: createCallbackCompartmentGlobals(),
    lockdown: true,
  });
  return typeof value === "function"
    ? hardenVerifiedFunction(value as (...args: any[]) => unknown)
    : value;
}

let sesInitialized = false;

const DEFAULT_LOCKDOWN_OPTIONS: SESLockdownOptions = {
  errorTaming: "safe",
  errorTrapping: "platform",
  reporting: "platform",
  unhandledRejectionTrapping: "report",
  regExpTaming: "safe",
  localeTaming: "safe",
  consoleTaming: "unsafe",
  overrideTaming: "severe",
  stackFiltering: "concise",
  domainTaming: "safe",
  evalTaming: "safe-eval",
  overrideDebug: [],
  legacyRegeneratorRuntimeTaming: "safe",
  __hardenTaming__: "safe",
};

function ensureSESInitialized(lockdownEnabled: boolean): void {
  if (sesInitialized || !lockdownEnabled) {
    return;
  }
  const lockdownFn = (globalThis as {
    lockdown?: (options?: SESLockdownOptions) => void;
  }).lockdown;
  if (typeof lockdownFn !== "function") {
    throw new Error("SES lockdown() is unavailable");
  }
  lockdownFn(DEFAULT_LOCKDOWN_OPTIONS);
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

function isPromiseLike(
  value: unknown,
): value is Promise<unknown> {
  return !!value && typeof (value as { catch?: unknown }).catch === "function";
}

function sanitizeInternalFrames(stack: string): string {
  return stack.split("\n").map((line) =>
    RUNNER_INTERNAL_FRAME_PATTERN.test(line) ? CT_INTERNAL : line
  ).join("\n");
}

const CT_INTERNAL = "    at <CT_INTERNAL>";
const RUNNER_INTERNAL_FRAME_PATTERN =
  /^\s*at(?: .*?)? \(?(?:file:\/\/)?[^)\n]*\/packages\/runner\/src\/[^)\n]+:\d+:\d+\)?$/;
