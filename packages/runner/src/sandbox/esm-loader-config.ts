/**
 * Ambient runtime flag for the experimental ESM module-record loader (the
 * `esmModuleLoader` experimental option). Mirrors the modern-data-model and
 * persistent-scheduler-state ambient flags: the `Runtime` constructor
 * propagates the explicit option here and reads the effective value back.
 *
 * Unlike those two, the default is seeded from the `CF_ESM_MODULE_LOADER`
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
    return value === "1" || value === "true";
  } catch {
    // Env access may be denied (no --allow-env); treat as unset / off.
    return false;
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
