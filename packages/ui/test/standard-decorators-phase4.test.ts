import { assert } from "@std/assert";
import { join } from "@std/path";

const ROOT = join(import.meta.dirname!, "..", "..", "..");

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

Deno.test("transitive ui slice type-checks under standard decorators", async () => {
  const rootConfigPath = join(ROOT, "deno.json");
  const rootConfig = JSON.parse(await Deno.readTextFile(rootConfigPath));

  rootConfig.compilerOptions ??= {};
  rootConfig.compilerOptions.experimentalDecorators = false;

  const tempConfig = join(ROOT, ".deno.standard-decorators.ui-phase4.json");
  await Deno.writeTextFile(tempConfig, JSON.stringify(rootConfig, null, 2));

  const files = [
    "packages/ui/src/v2/components/cf-audio-visualizer/cf-audio-visualizer.ts",
    "packages/ui/src/v2/components/cf-autocomplete/cf-autocomplete.ts",
    "packages/ui/src/v2/components/cf-button/cf-button.ts",
    "packages/ui/src/v2/components/cf-cell-context/cf-cell-context.ts",
    "packages/ui/src/v2/components/cf-tools-chip/cf-tools-chip.ts",
    "packages/ui/src/v2/components/cf-voice-input/cf-voice-input.ts",
    "packages/ui/src/v2/components/form/cf-form.ts",
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
    "transitive ui slice should pass under standard decorators",
  );
});
