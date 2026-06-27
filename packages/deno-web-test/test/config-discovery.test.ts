import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { findDenoConfigPath, readConfigIfExists } from "../utils.ts";

async function withTempDir(
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "deno-web-test-config-" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("findDenoConfigPath prefers deno.json, matching Deno's own resolution", async () => {
  await withTempDir(async (dir) => {
    await Deno.writeTextFile(join(dir, "deno.json"), "{}");
    await Deno.writeTextFile(join(dir, "deno.jsonc"), "{}");
    assertEquals(await findDenoConfigPath(dir), join(dir, "deno.json"));
  });
});

Deno.test("findDenoConfigPath falls back to deno.jsonc when only it exists", async () => {
  await withTempDir(async (dir) => {
    await Deno.writeTextFile(join(dir, "deno.jsonc"), "{}");
    assertEquals(await findDenoConfigPath(dir), join(dir, "deno.jsonc"));
  });
});

Deno.test("findDenoConfigPath returns deno.json when only it exists", async () => {
  await withTempDir(async (dir) => {
    await Deno.writeTextFile(join(dir, "deno.json"), "{}");
    assertEquals(await findDenoConfigPath(dir), join(dir, "deno.json"));
  });
});

Deno.test("findDenoConfigPath returns undefined when no config is present", async () => {
  await withTempDir(async (dir) => {
    assertEquals(await findDenoConfigPath(dir), undefined);
  });
});

Deno.test("readConfigIfExists parses a JSONC config, comments and all", async () => {
  await withTempDir(async (dir) => {
    const configPath = join(dir, "deno.jsonc");
    await Deno.writeTextFile(
      configPath,
      `{
  // a workspace package with imports
  "name": "pkg",
  "imports": { "x": "./x.ts" }
}
`,
    );
    const config = await readConfigIfExists(configPath);
    assertEquals(config?.name, "pkg");
    assertEquals(config?.imports, { x: "./x.ts" });
  });
});

Deno.test("readConfigIfExists returns undefined for a missing path", async () => {
  await withTempDir(async (dir) => {
    assertEquals(
      await readConfigIfExists(join(dir, "deno.jsonc")),
      undefined,
    );
  });
});

Deno.test("readConfigIfExists returns undefined when given no path", async () => {
  assertEquals(await readConfigIfExists(undefined), undefined);
});
