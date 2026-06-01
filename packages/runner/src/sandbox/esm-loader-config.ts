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
 * Propagate an explicit `esmModuleLoader` option. A `undefined` value is a no-op
 * so the env-seeded default stands (matching setDataModelConfig semantics).
 */
export function setEsmModuleLoaderConfig(enabled?: boolean): void {
  if (enabled !== undefined) {
    esmModuleLoaderEnabled = enabled;
  }
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
