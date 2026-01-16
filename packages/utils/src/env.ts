export function isDeno(): boolean {
  // Also check for `Deno.build`, because in `deno-web-test`,
  // a shim of `Deno.test` runs in the browser in order to run the same test suite.
  return ("Deno" in globalThis) && "build" in globalThis.Deno;
}

export function isBrowser(): boolean {
  return !isDeno() && ("fetch" in globalThis);
}

export function isWorkerThread(): boolean {
  return isDeno() ? ("close" in globalThis) : ("importScripts" in globalThis);
}

export function ensureNotRenderThread() {
  if (isBrowser() && !isWorkerThread()) {
    throw new Error(
      "This component must not run in the browser's main thread.",
    );
  }
}
