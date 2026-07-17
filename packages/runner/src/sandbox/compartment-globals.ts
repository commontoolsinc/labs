import { freezeSandboxRecordValues, freezeSandboxValue } from "./hardening.ts";
import { sandboxDateNow, sandboxRandom } from "../builder/safe-builtins.ts";

// A `Date` for the pattern sandbox whose ambient reads (`Date.now()` and the
// no-argument `new Date()`) route through the capability gate (coarse in a
// handler, throw in a lift/pattern-body), while every deterministic form
// (`new Date(value)`, `new Date(y, m, …)`, `Date.parse`, `Date.UTC`) and all
// prototype methods pass straight through to the real Date. This replaces the
// SES-tamed Date so authored `new Date()` is the safe API (W6). See
// docs/specs/sandboxing/TIMING_SIDE_CHANNELS.md.
function createGatedDate(): DateConstructor {
  const RealDate = Date;
  // The deep prototype-chain reads (`Date.prototype.constructor.now()` and
  // deeper) reach the shared Date only when SES lockdown has already tamed it to
  // throw. If this ran before lockdown, that path would re-expose the real
  // clock, so fail loud rather than injecting a leaky Date.
  if (RealDate.prototype.constructor === RealDate) {
    throw new Error(
      "createGatedDate() requires SES lockdown to have run first " +
        "(Date.prototype.constructor must be tamed); call ensureSESLockdown()",
    );
  }
  // deno-lint-ignore no-explicit-any
  const GatedDate: any = function (this: unknown, ...args: unknown[]) {
    if (new.target) {
      const ctorArgs = args.length === 0 ? [sandboxDateNow()] : args;
      return Reflect.construct(RealDate, ctorArgs as [], new.target);
    }
    // `Date()` called as a plain function returns a string of "now".
    return new RealDate(sandboxDateNow()).toString();
  };
  GatedDate.now = () => sandboxDateNow();
  GatedDate.parse = RealDate.parse;
  GatedDate.UTC = RealDate.UTC;
  // GatedDate gets its own prototype that inherits the real Date methods but
  // whose `constructor` is GatedDate, so `(new Date()).constructor` is the gated
  // Date (not an ungated one) while `instanceof Date` and the methods still work.
  const gatedProto = Object.create(RealDate.prototype);
  Object.defineProperty(gatedProto, "constructor", {
    value: GatedDate,
    writable: true,
    enumerable: false,
    configurable: true,
  });
  GatedDate.prototype = gatedProto;
  Object.defineProperty(GatedDate, "name", { value: "Date", writable: false });
  Object.defineProperty(GatedDate, "length", { value: 7 });
  return GatedDate as DateConstructor;
}

// A `Math` for the sandbox that keeps every real method/constant but routes
// `Math.random()` through the capability gate (raw entropy is allowed only in a
// handler; it breaks idempotency in a lift).
function createGatedMath(): typeof Math {
  const RealMath = Math as unknown as Record<PropertyKey, unknown>;
  const gated: Record<PropertyKey, unknown> = {};
  // Copy string and symbol keys (so `Symbol.toStringTag` -> "Math" survives).
  for (const key of Reflect.ownKeys(RealMath)) {
    gated[key] = RealMath[key];
  }
  gated.random = () => sandboxRandom();
  return gated as unknown as typeof Math;
}

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

  // Gated ambient clock/entropy (W6): authored `new Date()` / `Date.now()` /
  // `Math.random()` become the safe API instead of the SES-tamed throw.
  globals.Date = freezeSandboxValue(createGatedDate());
  globals.Math = freezeSandboxValue(createGatedMath());

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

  // `__cfReg({ symbol: value })` registers a module's hoisted builder artifacts
  // for content-addressed `{ identity, symbol }` lookup. The ESM module loader
  // supplies a real, identity-bound registrar as the module factory's 4th
  // parameter (which shadows this global inside that wrapper). On the legacy/AMD
  // bundle path identity addressing is not wired, so this global is a no-op — it
  // only needs to exist so a transformer-emitted `__cfReg({…})` call resolves
  // rather than throwing a ReferenceError.
  globals.__cfReg = freezeSandboxValue(() => undefined);

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
