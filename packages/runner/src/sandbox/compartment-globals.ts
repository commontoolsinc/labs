import { freezeSandboxRecordValues, freezeSandboxValue } from "./hardening.ts";

const CONSOLE_METHOD_NAMES = [
  "assert",
  "clear",
  "count",
  "countReset",
  "debug",
  "dir",
  "dirxml",
  "error",
  "group",
  "groupCollapsed",
  "groupEnd",
  "info",
  "log",
  "table",
  "time",
  "timeEnd",
  "timeLog",
  "timeStamp",
  "trace",
  "warn",
] as const;
const EMPTY_CONSOLE_METHOD = freezeSandboxValue(() => undefined);

function createCompatibilityGlobals(): Record<string, unknown> {
  const globals: Record<string, unknown> = {};
  const hostGlobals = globalThis as typeof globalThis & Record<string, unknown>;

  if (typeof globalThis.fetch === "function") {
    // Temporary migration shim: many existing patterns still perform direct
    // network requests from authored callbacks.
    globals.fetch = freezeSandboxValue(globalThis.fetch.bind(globalThis));
  }

  globals.Proxy = undefined;

  for (
    const name of [
      "Headers",
      "Request",
      "Response",
      "structuredClone",
      "TextDecoder",
      "TextEncoder",
      "URL",
      "URLSearchParams",
      "atob",
      "btoa",
    ] as const
  ) {
    const value = hostGlobals[name];
    if (value !== undefined) {
      globals[name] = freezeSandboxValue(value);
    }
  }

  globals.console = createSafeConsoleGlobal();
  return globals;
}

export function createModuleCompartmentGlobals(
  extras: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ...createCompatibilityGlobals(),
    ...freezeSandboxRecordValues(extras),
  };
}

export function createCallbackCompartmentGlobals(
  extras: Record<string, unknown> = {},
): Record<string, unknown> {
  return createModuleCompartmentGlobals(extras);
}

export function createSafeConsoleGlobal(
  consoleLike:
    | Record<string, unknown>
    | Console
    | undefined = globalThis.console as unknown as
      | Record<string, unknown>
      | undefined,
): Record<string, unknown> {
  const safeConsole: Record<string, unknown> = {};

  for (const methodName of CONSOLE_METHOD_NAMES) {
    const method = consoleLike?.[methodName];
    safeConsole[methodName] = typeof method === "function"
      ? freezeSandboxValue(method.bind(consoleLike))
      : EMPTY_CONSOLE_METHOD;
  }

  return freezeSandboxValue(safeConsole);
}
