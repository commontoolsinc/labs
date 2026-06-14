import { assert } from "@std/assert";
import { join } from "@std/path";

const ROOT = join(import.meta.dirname!, "..", "..", "..");

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

Deno.test("fourth transitive ui slice type-checks under standard decorators", async () => {
  const rootConfigPath = join(ROOT, "deno.json");
  const rootConfig = JSON.parse(await Deno.readTextFile(rootConfigPath));

  rootConfig.compilerOptions ??= {};
  rootConfig.compilerOptions.experimentalDecorators = false;

  const tempConfig = join(ROOT, ".deno.standard-decorators.ui-phase7.json");
  await Deno.writeTextFile(tempConfig, JSON.stringify(rootConfig, null, 2));

  const files = [
    "packages/ui/src/v2/components/cf-file-download/cf-file-download.ts",
    "packages/ui/src/v2/components/cf-file-input/cf-file-input.ts",
    "packages/ui/src/v2/components/cf-heading/cf-heading.ts",
    "packages/ui/src/v2/components/cf-image-input/cf-image-input.ts",
    "packages/ui/src/v2/components/cf-keybind/cf-keybind.ts",
    "packages/ui/src/v2/components/cf-link-preview/cf-link-preview.ts",
    "packages/ui/src/v2/components/cf-message-beads/cf-message-beads.ts",
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
    "fourth transitive ui slice should pass under standard decorators",
  );
});
