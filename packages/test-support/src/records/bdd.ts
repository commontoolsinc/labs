/**
 * `describe` and `it`, wrapped so that an invocation can be asked not to
 * run one of them.
 *
 * A test's identity is the name its runner reports, which for a file
 * written this way is the describe chain joined with `" > "`.
 * Registration does not follow that shape: `describe` registers one
 * `Deno.test` and every `it` inside it is a step within that one test, so
 * the preload's wrapper around `Deno.test` sees the container and never
 * the leaves. Reaching a leaf therefore needs a second interception, and
 * this is it.
 *
 * No test file changes. The root import map points `@std/testing/bdd` at
 * this module and the real one at a second specifier, so every file keeps
 * its own `import { describe, it } from "@std/testing/bdd"` and what that
 * specifier means changes once, centrally.
 *
 * A listed test is registered through `it.ignore` rather than dropped, so
 * it appears in the run's output and in its JUnit report as skipped and
 * the store learns it was deliberately not run instead of watching the
 * identity disappear.
 *
 * An invocation with no capture installed gets the real functions back
 * whole; see `capturing`.
 */

import { describe as realDescribe, it as realIt } from "@std/testing/bdd/real";
import {
  activeCapture,
  NAME_SEPARATOR,
  registerFrameworkModule,
  registeringFile,
  type RegistrationCapture,
} from "./registration.ts";

export {
  after,
  afterAll,
  afterEach,
  before,
  beforeAll,
  beforeEach,
} from "@std/testing/bdd/real";

// A test registered through this module is the caller's, not this
// module's, so the file attribution walks past these frames.
registerFrameworkModule(import.meta.url);

/**
 * The describe chain enclosing whatever is being registered right now.
 * `describe` runs its body while it registers, so pushing the title
 * around that call is what makes the chain available to the `it`s inside.
 */
const chain: string[] = [];

/** The name a bdd call was given, whichever way it was called. */
export function nameOf(args: readonly unknown[]): string | undefined {
  for (const arg of args) {
    if (typeof arg === "string") return arg;
    if (typeof arg === "object" && arg !== null) {
      const named = (arg as { name?: unknown }).name;
      if (typeof named === "string" && named.length > 0) return named;
    }
    if (typeof arg === "function" && arg.name.length > 0) return arg.name;
  }
  return undefined;
}

// deno-lint-ignore no-explicit-any
type AnyFunction = (...args: any[]) => any;

/** Where the body sits in a call, and what it is. */
export function bodyOf(
  args: readonly unknown[],
): { index: number; body: AnyFunction } | undefined {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (typeof arg === "function") {
      return { index, body: arg as AnyFunction };
    }
    if (typeof arg === "object" && arg !== null) {
      const fn = (arg as { fn?: unknown }).fn;
      if (typeof fn === "function") {
        return { index: -1, body: fn as AnyFunction };
      }
    }
  }
  return undefined;
}

/**
 * Wraps one `describe` entry point so the chain is pushed around the body
 * it registers. A shape this does not model reaches the real function
 * untouched, so an unfamiliar overload still runs and still reports its
 * own error.
 *
 * The capture is handed in rather than looked up, because a wrapper is
 * only built where one is installed.
 */
export function wrapDescribe(
  through: AnyFunction,
  capture: () => RegistrationCapture,
): AnyFunction {
  return (...args: unknown[]): unknown => {
    const name = nameOf(args);
    const found = bodyOf(args);
    if (name === undefined || found === undefined) return through(...args);
    const wrapped = function (this: unknown, ...rest: unknown[]): unknown {
      chain.push(name);
      try {
        return found.body.apply(this, rest);
      } finally {
        chain.pop();
      }
    };
    if (found.index >= 0) {
      const next = [...args];
      next[found.index] = wrapped;
      return through(...next);
    }
    return through(
      ...args.map((arg) =>
        typeof arg === "object" && arg !== null &&
          typeof (arg as { fn?: unknown }).fn === "function"
          ? { ...arg, fn: wrapped }
          : arg
      ),
    );
  };
}

/**
 * Wraps one `it` entry point so that a listed leaf is registered as
 * ignored, and so that the leaf's own file reaches the name map. The
 * leaf's identity is the enclosing chain and its own name joined, which
 * is what the store speaks in, and the file is read from the
 * registration stack the same way the preload reads it — the two
 * together, because the same test name occurs in more than one file.
 *
 * The preload's wrapper around `Deno.test` sees only the container the
 * describe chain registers, so without this the map holds one entry per
 * top-level suite title. Two files opening with the same title are then
 * one ambiguous entry, and every leaf under either of them loses its
 * file. Recording each leaf against its own file narrows that to two
 * files holding the same whole identity, which is a name clash rather
 * than a shared title.
 */
export function wrapIt(
  through: AnyFunction,
  ignore: AnyFunction,
  active: () => RegistrationCapture,
): AnyFunction {
  return (...args: unknown[]): unknown => {
    const capture = active();
    const name = nameOf(args);
    if (name === undefined) return through(...args);
    const identity = [...chain, name].join(NAME_SEPARATOR);
    const file = registeringFile(new Error().stack ?? "");
    if (file !== undefined) capture.names.set(identity, file);
    return capture.skipped(file, identity) ? ignore(...args) : through(...args);
  };
}

/** Copies the entry points hanging off a bdd function onto its wrapper. */
function withEntryPoints(
  wrapper: AnyFunction,
  real: AnyFunction,
  wrap: (through: AnyFunction) => AnyFunction,
): AnyFunction {
  for (const key of ["only", "skip", "ignore"] as const) {
    const entry = (real as unknown as Record<string, unknown>)[key];
    if (typeof entry === "function") {
      Reflect.set(wrapper, key, wrap(entry as AnyFunction));
    }
  }
  return wrapper;
}

/**
 * The capture installed before this module was evaluated, read once.
 *
 * Deno names a case's class after the nearest frame of the tree's own
 * code below the runner, so a wrapper here takes that name from the test
 * file whether or not it does anything with the call. With no capture
 * there is nothing for it to do, and the real functions go back whole,
 * so the report's class names name the file and ingestion reads the file
 * from those.
 *
 * Reading it once is what makes that possible: the exported binding is
 * either a wrapper or the real function, and it is fixed before the
 * first `describe` runs. The preload installs the capture before any
 * test module loads, and `installRegistrationCapture` reports an
 * invocation that loaded this module ahead of it. Nothing uninstalls a
 * capture, so a wrapper built here has one for as long as it lives.
 */
const capture = activeCapture();

/** `describe`, tracking the chain its body registers inside. */
export const describe: typeof realDescribe = capture === undefined
  ? realDescribe
  : withEntryPoints(
    wrapDescribe(realDescribe as unknown as AnyFunction, () => capture),
    realDescribe as unknown as AnyFunction,
    (through) => wrapDescribe(through, () => capture),
  ) as typeof realDescribe;

const realIgnore = (realIt as unknown as Record<string, AnyFunction>).ignore ??
  (realIt as unknown as AnyFunction);

/** `it`, registering a listed leaf as ignored rather than running it. */
export const it: typeof realIt = capture === undefined
  ? realIt
  : withEntryPoints(
    wrapIt(realIt as unknown as AnyFunction, realIgnore, () => capture),
    realIt as unknown as AnyFunction,
    (through) => wrapIt(through, realIgnore, () => capture),
  ) as typeof realIt;

/** The alias `@std/testing/bdd` gives `it`. */
export const test: typeof realIt = it;
