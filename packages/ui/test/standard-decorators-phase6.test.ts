import { assert } from "@std/assert";
import { join } from "@std/path";

const ROOT = join(import.meta.dirname!, "..", "..", "..");

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

Deno.test("third transitive ui slice type-checks under standard decorators", async () => {
  const rootConfigPath = join(ROOT, "deno.json");
  const rootConfig = JSON.parse(await Deno.readTextFile(rootConfigPath));

  rootConfig.compilerOptions ??= {};
  rootConfig.compilerOptions.experimentalDecorators = false;

  const tempConfig = join(ROOT, ".deno.standard-decorators.ui-phase6.json");
  await Deno.writeTextFile(tempConfig, JSON.stringify(rootConfig, null, 2));

  const files = [
    "packages/ui/src/v2/components/cf-chevron-button/cf-chevron-button.ts",
    "packages/ui/src/v2/components/cf-drag-source/cf-drag-source.ts",
    "packages/ui/src/v2/components/cf-draggable/cf-draggable.ts",
    "packages/ui/src/v2/components/cf-drop-zone/cf-drop-zone.ts",
    "packages/ui/src/v2/components/cf-location/cf-location.ts",
    "packages/ui/src/v2/components/cf-modal-provider/cf-modal-provider.ts",
    "packages/ui/src/v2/components/cf-modal/cf-modal.ts",
    "packages/ui/src/v2/components/cf-select/cf-select.ts",
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

  assert(
    output.success,
    "third transitive ui slice should pass under standard decorators",
  );
});
