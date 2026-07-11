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
      $EXPERIMENTAL_PERSISTENT_SCHEDULER_STATE: "true",
      // Explicit define overrides the environment-derived default (this
      // unpatched module resolves ENVIRONMENT=development, whose default
      // would otherwise be true).
      $EXPERIMENTAL_EAGER_SOURCE_ANNOTATION: "false",
    }, importFreshEnvModule);

    expect(mod.EXPERIMENTAL).toEqual({
      modernCellRep: true,
      persistentSchedulerState: true,
      eagerSourceAnnotation: false,
      // Default ON for the non-home root; home stays off.
      systemPatternAutoUpdate: true,
      systemPatternAutoUpdateHome: undefined,
    });
  },
});

Deno.test({
  name: "eagerSourceAnnotation defaults from the build environment",
  permissions: { read: true },
  async fn() {
    // Development (the default when $ENVIRONMENT is unset): debug `.src`
    // annotation ON so local debugging keeps per-primitive source locations.
    const dev = await withPatchedGlobals({
      $API_URL: "http://shell.test/",
      $EXPERIMENTAL_EAGER_SOURCE_ANNOTATION: undefined,
    }, importFreshEnvModule);
    expect(dev.EXPERIMENTAL.eagerSourceAnnotation).toBe(true);

    // Production: OFF — the eager resolution is the boot floor's largest
    // single cost.
    const prod = await withPatchedGlobals({
      $API_URL: "http://shell.test/",
      $ENVIRONMENT: "production",
      $EXPERIMENTAL_EAGER_SOURCE_ANNOTATION: undefined,
    }, importFreshEnvModule);
    expect(prod.EXPERIMENTAL.eagerSourceAnnotation).toBe(false);
  },
});

Deno.test({
  name:
    "shell env preserves the persistent scheduler default and exact override semantics",
  permissions: { read: true },
  async fn() {
    const unset = await withPatchedGlobals({
      $API_URL: "http://shell.test/",
      $EXPERIMENTAL_PERSISTENT_SCHEDULER_STATE: undefined,
    }, importFreshEnvModule);
    expect(unset.EXPERIMENTAL.persistentSchedulerState).toBeUndefined();

    const explicitFalse = await withPatchedGlobals({
      $API_URL: "http://shell.test/",
      $EXPERIMENTAL_PERSISTENT_SCHEDULER_STATE: "false",
    }, importFreshEnvModule);
    expect(explicitFalse.EXPERIMENTAL.persistentSchedulerState).toBe(false);

    const invalid = await withPatchedGlobals({
      $API_URL: "http://shell.test/",
      $EXPERIMENTAL_PERSISTENT_SCHEDULER_STATE: "1",
    }, importFreshEnvModule);
    expect(invalid.EXPERIMENTAL.persistentSchedulerState).toBeUndefined();
  },
});
