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
      EXPERIMENTAL_MODERN_CELL_REP: "true",
      EXPERIMENTAL_PERSISTENT_SCHEDULER_STATE: "true",
      EXPERIMENTAL_SERVER_PRIMARY_EXECUTION: "true",
      EXPERIMENTAL_SERVER_PRIMARY_EXECUTION_DOC_SET_WATCH: "true",
    }, importFreshConfig);

    expect(config.esbuild?.define).toMatchObject({
      $EXPERIMENTAL_MODERN_CELL_REP: "true",
      $EXPERIMENTAL_PERSISTENT_SCHEDULER_STATE: "true",
      $EXPERIMENTAL_SERVER_PRIMARY_EXECUTION: "true",
      // The F5 doc-set-watch subcap's browser own-side dial: without this
      // define the browser build cannot negotiate the subcapability at all
      // (the 2026-07-24 integration finding).
      $EXPERIMENTAL_SERVER_PRIMARY_EXECUTION_DOC_SET_WATCH: "true",
    });
    const compileCacheVersion = config.esbuild?.define[
      "globalThis.__cfCompileCacheRuntimeVersion"
    ];
    expect(compileCacheVersion?.startsWith("cf/esm-compile/")).toBe(true);
    expect(compileCacheVersion).not.toBe("cf/esm-compile/source");
  });
});
