import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

type EnvValues = Record<string, string | undefined>;

const FELT_CONFIG_URL = new URL("../felt.config.ts", import.meta.url);

async function withEnv<T>(
  values: EnvValues,
  run: () => Promise<T>,
): Promise<T> {
  const original = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    original.set(key, Deno.env.get(key));
    if (value === undefined) {
      Deno.env.delete(key);
    } else {
      Deno.env.set(key, value);
    }
  }

  try {
    return await run();
  } finally {
    for (const [key, value] of original.entries()) {
      if (value === undefined) {
        Deno.env.delete(key);
      } else {
        Deno.env.set(key, value);
      }
    }
  }
}

async function importFreshConfig() {
  const url = new URL(FELT_CONFIG_URL.href);
  url.searchParams.set("test", crypto.randomUUID());
  const module = await import(url.href);
  return module.default;
}

describe("shell felt config", () => {
  it("wires modern experimental env vars into build-time defines", async () => {
    const config = await withEnv({
      EXPERIMENTAL_MODERN_DATA_MODEL: "true",
      EXPERIMENTAL_MODERN_HASH: "true",
      EXPERIMENTAL_MODERN_SCHEMA_HASH: "true",
    }, importFreshConfig);

    expect(config.esbuild?.define).toMatchObject({
      $EXPERIMENTAL_MODERN_DATA_MODEL: "true",
      $EXPERIMENTAL_MODERN_HASH: "true",
      $EXPERIMENTAL_MODERN_SCHEMA_HASH: "true",
    });
  });
});
