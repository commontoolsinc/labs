import { assert } from "@std/assert";
import { join } from "@std/path";
import {
  readDenoConfig,
  runDenoCheckWithTemporaryConfig,
} from "@commonfabric/test-support/isolated-deno";

const ROOT = join(import.meta.dirname!, "..", "..", "..");

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

Deno.test("transitive ui slice type-checks under standard decorators", async () => {
  const rootConfigPath = join(ROOT, "deno.jsonc");
  const rootConfig = await readDenoConfig(rootConfigPath);

  rootConfig.compilerOptions ??= {};
  rootConfig.compilerOptions.experimentalDecorators = false;

  const files = [
    "packages/ui/src/v2/components/cf-audio-visualizer/cf-audio-visualizer.ts",
    "packages/ui/src/v2/components/cf-autocomplete/cf-autocomplete.ts",
    "packages/ui/src/v2/components/cf-button/cf-button.ts",
    "packages/ui/src/v2/components/cf-cell-context/cf-cell-context.ts",
    "packages/ui/src/v2/components/cf-tools-chip/cf-tools-chip.ts",
    "packages/ui/src/v2/components/cf-voice-input/cf-voice-input.ts",
    "packages/ui/src/v2/components/form/cf-form.ts",
  ];

  const output = await runDenoCheckWithTemporaryConfig({
    root: ROOT,
    config: rootConfig,
    files,
    tempConfigPrefix: "deno.standard-decorators.ui-phase4",
  });

  if (!output.success) {
    console.error(decode(output.stdout));
    console.error(decode(output.stderr));
  }

  assert(
    output.success,
    "transitive ui slice should pass under standard decorators",
  );
});
