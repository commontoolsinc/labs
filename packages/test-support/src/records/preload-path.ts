/**
 * Where the registration preload lives on disk. `deno test --preload`
 * takes a path rather than an import-map specifier, and a test task runs
 * with its own package as the working directory, so every caller needs an
 * absolute path rather than a relative one.
 */

import { fromFileUrl } from "@std/path";

/** Absolute path of the module `--preload` is pointed at. */
export function preloadModulePath(): string {
  return fromFileUrl(new URL("./preload.ts", import.meta.url));
}

/** The `--preload=<path>` argument naming that module. */
export function preloadArgument(): string {
  return `--preload=${preloadModulePath()}`;
}
