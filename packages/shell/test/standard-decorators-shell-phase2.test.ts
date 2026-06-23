import { assert } from "@std/assert";
import { join } from "@std/path";
import { runDenoCheckWithTemporaryConfig } from "@commonfabric/test-support/isolated-deno";

const ROOT = join(import.meta.dirname!, "..", "..", "..");

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

Deno.test("shell component slice type-checks under standard decorators", async () => {
  const rootConfigPath = join(ROOT, "deno.json");
  const rootConfig = JSON.parse(await Deno.readTextFile(rootConfigPath));

  rootConfig.compilerOptions ??= {};
  rootConfig.compilerOptions.experimentalDecorators = false;

  const files = [
    "packages/shell/src/components/Button.ts",
    "packages/shell/src/components/CFLogo.ts",
    "packages/shell/src/components/Flex.ts",
    "packages/shell/src/components/OmniLayout.ts",
    "packages/shell/src/components/PieceLink.ts",
    "packages/shell/src/components/PieceList.ts",
  ];

  const output = await runDenoCheckWithTemporaryConfig({
    root: ROOT,
    config: rootConfig,
    files,
    tempConfigPrefix: "deno.standard-decorators.shell-phase2",
  });

  if (!output.success) {
    console.error(decode(output.stdout));
    console.error(decode(output.stderr));
  }

  assert(
    output.success,
    "shell component slice should pass under standard decorators",
  );
});
