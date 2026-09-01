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
 */

import { describe as realDescribe, it as realIt } from "@std/testing/bdd/real";
import {
  activeCapture,
  NAME_SEPARATOR,
  registerFrameworkModule,
  registeringFile,
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
function nameOf(args: readonly unknown[]): string | undefined {
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
function bodyOf(
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
 * With no capture installed there is no skip list to apply, and the
 * chain would be read by nobody. The call goes straight through, so an
 * invocation that is not recording keeps its report's own class names:
 * a frame between the test file and `describe` moves where the runner
 * thinks the test was registered, and the class name is what ingestion
 * falls back to when there is no name map to join onto.
 */
function wrapDescribe(through: AnyFunction): AnyFunction {
  return (...args: unknown[]): unknown => {
    if (activeCapture() === undefined) return through(...args);
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
 * ignored. The leaf's identity is the enclosing chain and its own name
 * joined, which is what the store speaks in, and the file is read from
 * the registration stack the same way the preload reads it — the two
 * together, because the same test name occurs in more than one file.
 */
function wrapIt(through: AnyFunction, ignore: AnyFunction): AnyFunction {
  return (...args: unknown[]): unknown => {
    const capture = activeCapture();
    if (capture === undefined) return through(...args);
    const name = nameOf(args);
    if (name === undefined) return through(...args);
    const identity = [...chain, name].join(NAME_SEPARATOR);
    const file = registeringFile(new Error().stack ?? "");
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

/** `describe`, tracking the chain its body registers inside. */
export const describe = withEntryPoints(
  wrapDescribe(realDescribe as unknown as AnyFunction),
  realDescribe as unknown as AnyFunction,
  wrapDescribe,
) as typeof realDescribe;

const realIgnore = (realIt as unknown as Record<string, AnyFunction>).ignore ??
  (realIt as unknown as AnyFunction);

/** `it`, registering a listed leaf as ignored rather than running it. */
export const it = withEntryPoints(
  wrapIt(realIt as unknown as AnyFunction, realIgnore),
  realIt as unknown as AnyFunction,
  (through) => wrapIt(through, realIgnore),
) as typeof realIt;

/** The alias `@std/testing/bdd` gives `it`. */
export const test: typeof realIt = it;
