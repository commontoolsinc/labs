import { assert } from "@std/assert";
import { join } from "@std/path";
import { runDenoCheckWithTemporaryConfig } from "@commonfabric/test-support/isolated-deno";

const ROOT = join(import.meta.dirname!, "..", "..", "..");

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

Deno.test("phase 1 files type-check under standard decorators", async () => {
  const rootConfigPath = join(ROOT, "deno.json");
  const rootConfig = JSON.parse(await Deno.readTextFile(rootConfigPath));

  rootConfig.compilerOptions ??= {};
  rootConfig.compilerOptions.experimentalDecorators = false;

  const files = [
    "packages/shell/src/components/Button.ts",
    "packages/shell/src/components/CFLogo.ts",
    "packages/shell/src/components/Flex.ts",
    "packages/ui/src/v2/components/cf-attachments-bar/cf-attachments-bar.ts",
    "packages/ui/src/v2/components/cf-canvas/cf-canvas.ts",
    "packages/ui/src/v2/components/cf-chip/cf-chip.ts",
    "packages/ui/src/v2/components/cf-router/cf-router.ts",
    "packages/ui/src/v2/components/cf-tile/cf-tile.ts",
  ];

  const output = await runDenoCheckWithTemporaryConfig({
    root: ROOT,
    config: rootConfig,
    files,
    tempConfigPrefix: "deno.standard-decorators.phase1",
  });

  if (!output.success) {
    console.error(decode(output.stdout));
    console.error(decode(output.stderr));
  }

  assert(output.success, "phase 1 files should pass under standard decorators");
});
