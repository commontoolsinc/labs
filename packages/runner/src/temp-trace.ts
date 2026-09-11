/**
 * TEMP-INSTRUMENTATION (PR #7287): remove before merge. A console trace that
 * is always on in a browser, whose console the flag-on pattern job pipes into
 * its output, and on in Deno only where CF_TEMP_PRESYNC_TRACE=1, so command
 * output stays clean.
 */

export const tempTrace: (...args: unknown[]) => void = (() => {
  let enabled = true;
  if (typeof Deno !== "undefined") {
    try {
      enabled = Deno.env.get("CF_TEMP_PRESYNC_TRACE") === "1";
    } catch {
      enabled = false;
    }
  }
  return enabled ? (...args: unknown[]) => console.log(...args) : () => {};
})();
