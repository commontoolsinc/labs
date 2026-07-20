import { assert, assertEquals, assertMatch } from "@std/assert";
import { join } from "@std/path";
import {
  readDenoConfig,
  runDenoCheckWithTemporaryConfig,
} from "./isolated-deno.ts";

const ROOT = join(import.meta.dirname!, "..", "..", "..");

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

Deno.test("nested checks use the checked-in dependency graph", async () => {
  const lockPath = join(ROOT, "deno.lock");
  const lockBefore = await Deno.readTextFile(lockPath);
  const rootConfig = await readDenoConfig(join(ROOT, "deno.jsonc"));

  rootConfig.compilerOptions ??= {};
  rootConfig.compilerOptions.experimentalDecorators = false;

  const output = await runDenoCheckWithTemporaryConfig({
    root: ROOT,
    config: rootConfig,
    files: ["packages/test-support/src/mod.ts"],
    tempConfigPrefix: "deno.test-support.frozen-check",
  });

  assert(
    output.success,
    `nested check failed:\n${decode(output.stdout)}\n${decode(output.stderr)}`,
  );
  assertEquals(await Deno.readTextFile(lockPath), lockBefore);
});

Deno.test("nested checks reject dependency graph changes", async () => {
  const rootConfig = await readDenoConfig(join(ROOT, "deno.jsonc"));
  const shellConfig = await readDenoConfig(
    join(ROOT, "packages", "shell", "deno.jsonc"),
  );
  const rootImports = rootConfig.imports ?? {};
  const packageImport = Object.entries(shellConfig.imports ?? {}).find(
    ([name]) => !(name in rootImports),
  );

  assert(packageImport, "shell config should contain a package-only import");
  const [name, specifier] = packageImport;
  rootConfig.imports = { ...rootImports, [name]: specifier };

  const output = await runDenoCheckWithTemporaryConfig({
    root: ROOT,
    config: rootConfig,
    files: ["packages/test-support/src/mod.ts"],
    tempConfigPrefix: "deno.test-support.changed-dependencies",
  });
  const stderr = decode(output.stderr);

  assert(!output.success, "a changed dependency graph should fail the check");
  assertMatch(stderr, /lockfile is out of date/i);
});
