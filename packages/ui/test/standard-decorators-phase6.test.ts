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

Deno.test("third transitive ui slice type-checks under standard decorators", async () => {
  const rootConfigPath = join(ROOT, "deno.jsonc");
  const rootConfig = await readDenoConfig(rootConfigPath);

  rootConfig.compilerOptions ??= {};
  rootConfig.compilerOptions.experimentalDecorators = false;

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

  const output = await runDenoCheckWithTemporaryConfig({
    root: ROOT,
    config: rootConfig,
    files,
    tempConfigPrefix: "deno.standard-decorators.ui-phase6",
  });

  if (!output.success) {
    console.error(decode(output.stdout));
    console.error(decode(output.stderr));
  }

  assert(
    output.success,
    "third transitive ui slice should pass under standard decorators",
  );
});
