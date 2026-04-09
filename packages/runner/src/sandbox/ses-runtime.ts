import {
  JsScript,
  MappedPosition,
  SourceMap,
  SourceMapParser,
} from "@commonfabric/js-compiler";
import { getLogger } from "@commonfabric/utils/logger";
import "ses";
import { createCallbackCompartmentGlobals } from "./compartment-globals.ts";
import { hardenVerifiedFunction } from "./function-hardening.ts";

const logger = getLogger("ses-runtime");

export interface SESRuntimeOptions {
  globals?: Record<string, unknown>;
  lockdown?: boolean;
  hideInternalStackFrames?: boolean;
}

interface SESCompartmentLike {
  evaluate(source: string): unknown;
  globalThis?: object;
}

export interface JsValue {
  invoke(...args: unknown[]): JsValue;
  inner(): unknown;
  asObject(): object;
  isObject(): boolean;
}

class SESInternals {
  private sourceMaps = new SourceMapParser();

  constructor(private options: SESRuntimeOptions = {}) {}

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
    const mappedStack = this.sourceMaps.parse(stack);
    return this.options.hideInternalStackFrames
      ? sanitizeInternalFrames(mappedStack)
      : mappedStack;
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
  private globals: Record<string, unknown>;
  private internals: SESInternals;

  constructor(
    private options: SESRuntimeOptions = {},
    internals?: SESInternals,
  ) {
    this.internals = internals ?? new SESInternals(options);
    this.globals = { ...(options.globals ?? {}) };
    ensureSESInitialized(!!options.lockdown);
  }

  execute(input: string | JsScript): SESJsValue {
    logger.timeStart("execute");
    try {
      const { js, filename, sourceMap } = typeof input === "string"
        ? { js: input, filename: "NO-NAME.js" }
        : input;

      if (filename && sourceMap) {
        this.internals.loadSourceMap(filename, sourceMap);
      }

      logger.timeStart("execute", "createCompartment");
      let compartment;
      try {
        compartment = createCompartment(this.globals);
      } finally {
        logger.timeEnd("execute", "createCompartment");
      }

      logger.timeStart("execute", "compartmentEvaluate");
      try {
        const result = this.internals.exec(() => compartment.evaluate(js));
        return new SESJsValue(this.internals, result);
      } finally {
        logger.timeEnd("execute", "compartmentEvaluate");
      }
    } finally {
      logger.timeEnd("execute");
    }
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
  private internals: SESInternals;
  private isolates = new Map<string, SESIsolate>();
  private callbackEvaluator: SESCallbackEvaluator;

  constructor(private options: SESRuntimeOptions = {}) {
    super();
    this.internals = new SESInternals(options);
    this.callbackEvaluator = new SESCallbackEvaluator(options);
  }

  getIsolate(key: string): SESIsolate {
    const existing = this.isolates.get(key);
    if (existing) {
      return existing;
    }

    const isolate = new SESIsolate(this.options, this.internals);
    this.isolates.set(key, isolate);
    return isolate;
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

  evaluateCallback(source: string): unknown {
    return this.callbackEvaluator.evaluate(source);
  }

  clear(): void {
    this.internals.clear();
    this.callbackEvaluator.clear();
    this.isolates.clear();
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
    if (e instanceof Error) {
      materializeHostVisibleStack(e);
    }
    throw e;
  }
}

export function ensureSESLockdown(): void {
  ensureSESInitialized(true);
}

export function evaluateCallbackSourceInSES(
  source: string,
  options: SESRuntimeOptions = {},
): unknown {
  return new SESCallbackEvaluator(options).evaluate(source);
}

let sesInitialized = false;
const SES_RUNTIME_STATE = Symbol.for("@commonfabric/runner/ses-runtime-state");

function ensureSESInitialized(lockdownEnabled: boolean): void {
  if (!lockdownEnabled) {
    return;
  }
  const globalState = getGlobalSESRuntimeState();
  if (sesInitialized || globalState.lockdownInitialized) {
    sesInitialized = true;
    return;
  }
  const lockdownFn = (globalThis as {
    lockdown?: (options?: SESLockdownOptions) => void;
  }).lockdown;
  if (typeof lockdownFn !== "function") {
    throw new Error("SES lockdown() is unavailable");
  }
  lockdownFn(DEFAULT_LOCKDOWN_OPTIONS);
  globalState.lockdownInitialized = true;
  sesInitialized = true;
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

const DEFAULT_LOCKDOWN_OPTIONS: SESLockdownOptions = {
  errorTaming: "safe",
  errorTrapping: "platform",
  reporting: "none",
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

function createCompartment(globals: Record<string, unknown>) {
  const CompartmentCtor = (globalThis as {
    Compartment?: new (
      globals?: Record<string, unknown>,
    ) => SESCompartmentLike;
  }).Compartment;
  if (!CompartmentCtor) {
    throw new Error("SES Compartment is unavailable");
  }
  const compartment = new CompartmentCtor(globals);
  // SES freezes intrinsics, but compartment global bindings remain writable
  // unless we explicitly lock them down.
  Object.freeze(compartment.globalThis);
  return compartment;
}

class SESCallbackEvaluator {
  private callbackCompartment: SESCompartmentLike | undefined;
  private callbackCreatorCache = new Map<string, () => unknown>();

  constructor(private options: SESRuntimeOptions = {}) {}

  evaluate(source: string): unknown {
    const normalizedSource = normalizeDirectFunctionSource(source);
    const createCallback = this.getCachedCallbackCreator(normalizedSource);

    return hardenVerifiedFunction((...args: unknown[]) => {
      const fn = createCallback();
      if (typeof fn !== "function") {
        throw new Error("Callback source did not produce a function");
      }
      return Reflect.apply(
        hardenVerifiedFunction(fn as (...args: unknown[]) => unknown),
        undefined,
        args,
      );
    });
  }

  clear(): void {
    this.callbackCreatorCache.clear();
    this.callbackCompartment = undefined;
  }

  private getCachedCallbackCreator(source: string): () => unknown {
    const cached = this.callbackCreatorCache.get(source);
    if (cached) {
      return cached;
    }

    const compartment = this.getSharedCallbackCompartment();
    const creator = compartment.evaluate(createCallbackCreatorSource(source));
    if (typeof creator !== "function") {
      throw new Error("Callback source must evaluate to a function creator");
    }

    this.callbackCreatorCache.set(source, creator as () => unknown);
    return creator as () => unknown;
  }

  private getSharedCallbackCompartment(): SESCompartmentLike {
    ensureSESInitialized(true);
    if (!this.callbackCompartment) {
      this.callbackCompartment = createCompartment(
        createCallbackCompartmentGlobals(this.options.globals ?? {}),
      );
    }
    return this.callbackCompartment;
  }
}

function normalizeDirectFunctionSource(source: string): string {
  const trimmedSource = source.trim();
  if (trimmedSource.length === 0) {
    throw new Error("Callback source must not be empty");
  }
  return trimmedSource;
}

function createCallbackCreatorSource(source: string): string {
  const callbackExpression = JSON.stringify(`(${source})`);
  return `(() => {
    const source = ${callbackExpression};
    return () => {
      const fn = (0, eval)(source);
      if (typeof fn !== "function") {
        throw new Error("Callback source did not produce a function");
      }
      return fn;
    };
  })()`;
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
    RUNNER_INTERNAL_FRAME_PATTERN.test(line) ? CF_INTERNAL : line
  ).join("\n");
}

const CF_INTERNAL = "    at <CF_INTERNAL>";
const RUNNER_INTERNAL_FRAME_PATTERN =
  /^\s*at(?: .*?)? \(?(?:file:\/\/)?(?:[^)\n]*\/)?packages\/runner\/src\/[^)\n]+:\d+:\d+\)?$/;

function getGlobalSESRuntimeState(): { lockdownInitialized: boolean } {
  const globalObject = globalThis as typeof globalThis & {
    [SES_RUNTIME_STATE]?: { lockdownInitialized: boolean };
  };
  if (!globalObject[SES_RUNTIME_STATE]) {
    globalObject[SES_RUNTIME_STATE] = { lockdownInitialized: false };
  }
  return globalObject[SES_RUNTIME_STATE];
}
