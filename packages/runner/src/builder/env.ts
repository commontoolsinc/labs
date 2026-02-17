import { isDeno } from "@commontools/utils/env";

// Environment configuration provided to patterns. Could
// eventually be e.g. `import.meta` exposed to patterns.
//
// /!\ These should not be globals (outside of pattern execution context).
// /!\ Execution needs to be sandboxed to prevent patterns setting these values.

// Environment configuration available to patterns.
export interface PatternEnvironment {
  readonly apiUrl: URL;
}

let globalEnv = {
  apiUrl: isDeno()
    ? new URL("http://localhost:8000")
    : new URL(new URL(globalThis.location.href).origin),
};

// Sets the `PatternEnvironment` for all patterns executed
// within this JavaScript context.
export function setPatternEnvironment(env: PatternEnvironment) {
  globalEnv = env;
}

// Gets the `PatternEnvironment` for all patterns executed
// within this JavaScript context.
//
// User-visible.
export function getPatternEnvironment(): PatternEnvironment {
  return globalEnv;
}
