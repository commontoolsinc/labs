/**
 * Conditional console that suppresses output when running in Deno,
 * to prevent interference with CLI output during normal operation.
 * 
 * Since we no longer have a --debug flag, this simply suppresses
 * console output in Deno environments to keep CLI output clean.
 */

const isDeno = typeof Deno !== "undefined";

class NoOpConsole
  implements Pick<Console, "log" | "debug" | "info" | "warn" | "error"> {
  log() {}
  debug() {}
  info() {}
  warn() {}
  error() {}
}

// In Deno, use NoOpConsole to suppress output
export const conditionalConsole = isDeno
  ? new NoOpConsole()
  : globalThis.console;
