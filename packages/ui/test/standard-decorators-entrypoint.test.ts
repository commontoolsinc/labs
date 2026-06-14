import { assert } from "@std/assert";
import { join } from "@std/path";
import { runDenoCheckWithTemporaryConfig } from "@commonfabric/test-support/isolated-deno";

const ROOT = join(import.meta.dirname!, "..", "..", "..");

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

Deno.test("ui entrypoint type-checks under standard decorators", async () => {
  const rootConfig = JSON.parse(
    await Deno.readTextFile(join(ROOT, "deno.json")),
  );
  const packageConfig = JSON.parse(
    await Deno.readTextFile(join(ROOT, "packages", "ui", "deno.json")),
  );

  rootConfig.compilerOptions ??= {};
  rootConfig.compilerOptions.experimentalDecorators = false;
  rootConfig.imports = {
    ...(rootConfig.imports ?? {}),
    ...(packageConfig.imports ?? {}),
  };

  const output = await runDenoCheckWithTemporaryConfig({
    root: ROOT,
    config: rootConfig,
    files: ["packages/ui/src/index.ts"],
    tempConfigPrefix: "deno.standard-decorators.ui-entrypoint",
  });

  if (!output.success) {
    console.error(decode(output.stdout));
    console.error(decode(output.stderr));
  }

  assert(output.success, "ui entrypoint should pass under standard decorators");
});
