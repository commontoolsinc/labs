/**
 * Experimental-flag VALUE parsing, alone in its own module: the browser
 * shell reads the same `EXPERIMENTAL_*` vocabulary from its build-time
 * defines, and importing the parser must not pull the presets module's
 * dependency graph into the page bundle. Everything else about the
 * experimental posture lives in `runtime-presets.ts`, which re-exports
 * this.
 */

/** The canonical parse: exactly `"true"` / `"false"`, anything else ignored. */
export function parseFlagValue(
  raw: string,
  source: string,
): boolean | undefined {
  if (raw === "true" || raw === "false") return raw === "true";
  console.warn(
    `[runtime-presets] Ignoring ${source}="${raw}" — ` +
      `expected "true" or "false" (unset = default).`,
  );
  return undefined;
}
