import { expect } from "@std/expect";

type ShellEnvGlobals = typeof globalThis & Record<string, string | undefined>;

function importFreshEnvModule() {
  return import(
    new URL(`../src/lib/env.ts?case=${crypto.randomUUID()}`, import.meta.url)
      .href
  );
}

function withPatchedGlobals<T>(
  globals: Record<string, string | undefined>,
  fn: () => Promise<T>,
): Promise<T> {
  const env = globalThis as ShellEnvGlobals;
  const original = Object.fromEntries(
    Object.keys(globals).map((key) => [key, env[key]]),
  );
  for (const [key, value] of Object.entries(globals)) {
    env[key] = value;
  }
  return fn().finally(() => {
    for (const [key, value] of Object.entries(original)) {
      env[key] = value;
    }
  });
}

Deno.test({
  name: "shell env reads the modern experimental globals",
  permissions: { read: true },
  async fn() {
    const mod = await withPatchedGlobals({
      $API_URL: "http://shell.test/",
      $EXPERIMENTAL_MODERN_CELL_REP: "true",
      $EXPERIMENTAL_MODERN_DATA_MODEL: "true",
      $EXPERIMENTAL_PERSISTENT_SCHEDULER_STATE: "true",
    }, importFreshEnvModule);

    expect(mod.EXPERIMENTAL).toEqual({
      modernCellRep: true,
      modernDataModel: true,
      persistentSchedulerState: true,
    });
  },
});

Deno.test({
  name:
    "shell env reads the ESM module loader flag (CF_ESM_MODULE_LOADER, '1'|'true')",
  permissions: { read: true },
  async fn() {
    // Accepts "1" (matching the runner's readEnvDefault), not just "true".
    const enabled = await withPatchedGlobals({
      $API_URL: "http://shell.test/",
      $EXPERIMENTAL_ESM_MODULE_LOADER: "1",
    }, importFreshEnvModule);
    expect(enabled.EXPERIMENTAL.esmModuleLoader).toBe(true);

    const enabledTrue = await withPatchedGlobals({
      $API_URL: "http://shell.test/",
      $EXPERIMENTAL_ESM_MODULE_LOADER: "true",
    }, importFreshEnvModule);
    expect(enabledTrue.EXPERIMENTAL.esmModuleLoader).toBe(true);

    // Any other set value is explicitly off.
    const disabled = await withPatchedGlobals({
      $API_URL: "http://shell.test/",
      $EXPERIMENTAL_ESM_MODULE_LOADER: "0",
    }, importFreshEnvModule);
    expect(disabled.EXPERIMENTAL.esmModuleLoader).toBe(false);

    // Unset → undefined (runtime falls back to its own default).
    const unset = await withPatchedGlobals({
      $API_URL: "http://shell.test/",
      $EXPERIMENTAL_ESM_MODULE_LOADER: undefined,
    }, importFreshEnvModule);
    expect(unset.EXPERIMENTAL.esmModuleLoader).toBe(undefined);
  },
});
