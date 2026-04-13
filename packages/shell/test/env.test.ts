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
      $EXPERIMENTAL_MODERN_DATA_MODEL: "true",
      $EXPERIMENTAL_UNIFIED_JSON_ENCODING: "false",
      $EXPERIMENTAL_MODERN_HASH: "true",
      $EXPERIMENTAL_MODERN_SCHEMA_HASH: "false",
      $EXPERIMENTAL_RICH_STORABLE_VALUES: undefined,
      $EXPERIMENTAL_STORABLE_PROTOCOL: undefined,
      $EXPERIMENTAL_CANONICAL_HASHING: undefined,
    }, importFreshEnvModule);

    expect(mod.EXPERIMENTAL).toEqual({
      modernDataModel: true,
      unifiedJsonEncoding: false,
      modernHash: true,
      modernSchemaHash: false,
    });
  },
});

Deno.test({
  name: "shell env ignores defunct legacy experimental globals",
  permissions: { read: true },
  async fn() {
    const mod = await withPatchedGlobals({
      $API_URL: "http://shell.test/",
      $EXPERIMENTAL_MODERN_DATA_MODEL: undefined,
      $EXPERIMENTAL_UNIFIED_JSON_ENCODING: undefined,
      $EXPERIMENTAL_MODERN_HASH: undefined,
      $EXPERIMENTAL_MODERN_SCHEMA_HASH: undefined,
      $EXPERIMENTAL_RICH_STORABLE_VALUES: "true",
      $EXPERIMENTAL_STORABLE_PROTOCOL: "true",
      $EXPERIMENTAL_CANONICAL_HASHING: "true",
    }, importFreshEnvModule);

    expect(mod.EXPERIMENTAL).toEqual({
      modernDataModel: undefined,
      unifiedJsonEncoding: undefined,
      modernHash: undefined,
      modernSchemaHash: undefined,
    });
  },
});
