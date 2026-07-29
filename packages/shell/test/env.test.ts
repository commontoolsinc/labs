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
      $EXPERIMENTAL_SERVER_PRIMARY_EXECUTION: "true",
      $EXPERIMENTAL_SERVER_PRIMARY_EXECUTION_DOC_SET_WATCH: "true",
      $EXPERIMENTAL_SERVER_PRIMARY_EXECUTION_CONTEXT_LATTICE_CLAIMS: "true",
      // Explicit define overrides the environment-derived default (this
      // unpatched module resolves ENVIRONMENT=development, whose default
      // would otherwise be true).
      $EXPERIMENTAL_EAGER_SOURCE_ANNOTATION: "false",
    }, importFreshEnvModule);

    expect(mod.EXPERIMENTAL).toEqual({
      modernCellRep: true,
      persistentSchedulerState: true,
      serverPrimaryExecution: true,
      serverPrimaryExecutionDocSetWatch: true,
      serverPrimaryExecutionContextLatticeClaims: true,
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
  // The browser's own-side half of the F5 doc-set-watch dial (server-side
  // execution feed): without this key the browser build can never negotiate
  // the subcapability, whatever the server advertises — the 2026-07-24
  // integration finding. Layered above serverPrimaryExecution exactly like
  // the runner option; no build-environment default.
  name:
    "shell env exposes the server-primary doc-set-watch flag with exact override semantics",
  permissions: { read: true },
  async fn() {
    const unset = await withPatchedGlobals({
      $API_URL: "http://shell.test/",
      $EXPERIMENTAL_SERVER_PRIMARY_EXECUTION_DOC_SET_WATCH: undefined,
    }, importFreshEnvModule);
    // The key must EXIST (so the worker init data always carries the
    // decision) while an unset define means "runtime default".
    expect("serverPrimaryExecutionDocSetWatch" in unset.EXPERIMENTAL).toBe(
      true,
    );
    expect(unset.EXPERIMENTAL.serverPrimaryExecutionDocSetWatch)
      .toBeUndefined();

    const explicitFalse = await withPatchedGlobals({
      $API_URL: "http://shell.test/",
      $EXPERIMENTAL_SERVER_PRIMARY_EXECUTION_DOC_SET_WATCH: "false",
    }, importFreshEnvModule);
    expect(explicitFalse.EXPERIMENTAL.serverPrimaryExecutionDocSetWatch).toBe(
      false,
    );

    const invalid = await withPatchedGlobals({
      $API_URL: "http://shell.test/",
      $EXPERIMENTAL_SERVER_PRIMARY_EXECUTION_DOC_SET_WATCH: "1",
    }, importFreshEnvModule);
    expect(invalid.EXPERIMENTAL.serverPrimaryExecutionDocSetWatch)
      .toBeUndefined();
  },
});

Deno.test({
  // The browser's own-side half of the C1.7 context-lattice-claims-v1 dial.
  // Same shape as the doc-set-watch pin above, and the same reason it exists:
  // without this key the browser build can never negotiate the subcapability
  // whatever the server advertises, and since the amendment-11 cohort gate
  // requires EVERY session of a principal to have negotiated, a single
  // non-negotiating browser session makes the principal's user lanes
  // un-openable (client-passivity §5g item 5, the CA4 audit).
  name:
    "shell env exposes the context-lattice-claims flag with exact override semantics",
  permissions: { read: true },
  async fn() {
    const unset = await withPatchedGlobals({
      $API_URL: "http://shell.test/",
      $EXPERIMENTAL_SERVER_PRIMARY_EXECUTION_CONTEXT_LATTICE_CLAIMS: undefined,
    }, importFreshEnvModule);
    expect(
      "serverPrimaryExecutionContextLatticeClaims" in unset.EXPERIMENTAL,
    ).toBe(true);
    expect(unset.EXPERIMENTAL.serverPrimaryExecutionContextLatticeClaims)
      .toBeUndefined();

    const explicitTrue = await withPatchedGlobals({
      $API_URL: "http://shell.test/",
      $EXPERIMENTAL_SERVER_PRIMARY_EXECUTION_CONTEXT_LATTICE_CLAIMS: "true",
    }, importFreshEnvModule);
    expect(explicitTrue.EXPERIMENTAL.serverPrimaryExecutionContextLatticeClaims)
      .toBe(true);

    const explicitFalse = await withPatchedGlobals({
      $API_URL: "http://shell.test/",
      $EXPERIMENTAL_SERVER_PRIMARY_EXECUTION_CONTEXT_LATTICE_CLAIMS: "false",
    }, importFreshEnvModule);
    expect(
      explicitFalse.EXPERIMENTAL.serverPrimaryExecutionContextLatticeClaims,
    ).toBe(false);

    const invalid = await withPatchedGlobals({
      $API_URL: "http://shell.test/",
      $EXPERIMENTAL_SERVER_PRIMARY_EXECUTION_CONTEXT_LATTICE_CLAIMS: "1",
    }, importFreshEnvModule);
    expect(invalid.EXPERIMENTAL.serverPrimaryExecutionContextLatticeClaims)
      .toBeUndefined();
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
