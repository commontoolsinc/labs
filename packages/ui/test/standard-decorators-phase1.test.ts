import { assert } from "@std/assert";
import { join } from "@std/path";

const ROOT = join(import.meta.dirname!, "..", "..", "..");

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

Deno.test("phase 1 files type-check under standard decorators", async () => {
  const rootConfigPath = join(ROOT, "deno.json");
  const rootConfig = JSON.parse(await Deno.readTextFile(rootConfigPath));

  rootConfig.compilerOptions ??= {};
  rootConfig.compilerOptions.experimentalDecorators = false;

  const tempConfig = join(ROOT, ".deno.standard-decorators.phase1.json");
  await Deno.writeTextFile(tempConfig, JSON.stringify(rootConfig, null, 2));

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

  const output = await new Deno.Command(Deno.execPath(), {
    cwd: ROOT,
    args: ["check", "--config", tempConfig, ...files],
    stdout: "piped",
    stderr: "piped",
  }).output();

  await Deno.remove(tempConfig);

  if (!output.success) {
    console.error(decode(output.stdout));
    console.error(decode(output.stderr));
  }

  assert(output.success, "phase 1 files should pass under standard decorators");
});
