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

Deno.test("fourth transitive ui slice type-checks under standard decorators", async () => {
  const rootConfigPath = join(ROOT, "deno.jsonc");
  const rootConfig = await readDenoConfig(rootConfigPath);

  rootConfig.compilerOptions ??= {};
  rootConfig.compilerOptions.experimentalDecorators = false;

  const files = [
    "packages/ui/src/v2/components/cf-file-download/cf-file-download.ts",
    "packages/ui/src/v2/components/cf-file-input/cf-file-input.ts",
    "packages/ui/src/v2/components/cf-heading/cf-heading.ts",
    "packages/ui/src/v2/components/cf-image-input/cf-image-input.ts",
    "packages/ui/src/v2/components/cf-keybind/cf-keybind.ts",
    "packages/ui/src/v2/components/cf-link-preview/cf-link-preview.ts",
    "packages/ui/src/v2/components/cf-message-beads/cf-message-beads.ts",
  ];

  const output = await runDenoCheckWithTemporaryConfig({
    root: ROOT,
    config: rootConfig,
    files,
    tempConfigPrefix: "deno.standard-decorators.ui-phase7",
  });

  if (!output.success) {
    console.error(decode(output.stdout));
    console.error(decode(output.stderr));
  }

  assert(
    output.success,
    "fourth transitive ui slice should pass under standard decorators",
  );
});
