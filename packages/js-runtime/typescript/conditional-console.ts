/**
 * Conditional console that suppresses output when running in Deno.
 * This prevents debug logs from interfering with CLI output.
 */

const isDeno = typeof Deno !== "undefined";

class NoOpConsole implements Pick<Console, "log" | "debug" | "info" | "warn" | "error"> {
  log() {}
  debug() {}
  info() {}
  warn() {}
  error() {}
}

export const conditionalConsole = isDeno ? new NoOpConsole() : globalThis.console;