/**
 * Ambient runtime flag for the experimental ESM module-record loader (the
 * `esmModuleLoader` experimental option). Mirrors the
 * persistent-scheduler-state ambient flag: the `Runtime` constructor
 * propagates the explicit option here and reads the effective value back.
 *
 * The default is ON: the ESM module-record loader is the production default.
 * Set `CF_ESM_MODULE_LOADER=0` (or `false`) to opt back into the legacy AMD
 * bundle loader. The env var also lets the loader be selected suite-wide (e.g. a
 * regression cross-check) without threading the option through every `Runtime`
 * construction.
 */

function readEnvDefault(): boolean {
  try {
    const value = (globalThis as {
      Deno?: { env?: { get(name: string): string | undefined } };
    }).Deno?.env?.get?.("CF_ESM_MODULE_LOADER");
    // Default ON: the ESM module-record loader is the default loader; opt out
    // with CF_ESM_MODULE_LOADER=0 (or "false").
    return value !== "0" && value !== "false";
  } catch {
    // Env access denied (no --allow-env): use the default (ON).
    return true;
  }
}

let esmModuleLoaderEnabled = readEnvDefault();

/**
 * Propagate an explicit `esmModuleLoader` option. `undefined` (no option) falls
 * back to the env-seeded default rather than leaving a prior value in place, so
 * a Runtime created without the option never inherits a stale override from an
 * earlier Runtime — the effective value is always either this Runtime's explicit
 * option or `CF_ESM_MODULE_LOADER`.
 */
export function setEsmModuleLoaderConfig(enabled?: boolean): void {
  esmModuleLoaderEnabled = enabled ?? readEnvDefault();
}

/** The effective ESM-loader flag (explicit option, else `CF_ESM_MODULE_LOADER`). */
export function getEsmModuleLoaderConfig(): boolean {
  return esmModuleLoaderEnabled;
}

/** Restore the env-seeded default. Called on `Runtime.dispose()` so the flag
 * does not leak between runtime instances or test runs. */
export function resetEsmModuleLoaderConfig(): void {
  esmModuleLoaderEnabled = readEnvDefault();
}
