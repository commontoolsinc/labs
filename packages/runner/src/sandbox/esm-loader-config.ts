/**
 * Ambient runtime flag for the experimental ESM module-record loader (the
 * `esmModuleLoader` experimental option). Mirrors the
 * persistent-scheduler-state ambient flag: the `Runtime` constructor
 * propagates the explicit option here and reads the effective value back.
 *
 * Unlike that one, the default is seeded from the `CF_ESM_MODULE_LOADER`
 * environment variable, so the ESM loader can be exercised suite-wide (e.g. a
 * regression cross-check) without threading the option through every `Runtime`
 * construction. The production default stays OFF (the env var is unset), so this
 * is NOT the flag flip — it only makes the flag toggleable from the environment.
 */

function readEnvDefault(): boolean {
  try {
    const value = (globalThis as {
      Deno?: { env?: { get(name: string): string | undefined } };
    }).Deno?.env?.get?.("CF_ESM_MODULE_LOADER");
    // VERIFY BRANCH (DO NOT MERGE): ESM loader default ON to run the whole
    // suite through the ESM path with the CT-1623 fix applied.
    return value !== "0" && value !== "false";
  } catch {
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
