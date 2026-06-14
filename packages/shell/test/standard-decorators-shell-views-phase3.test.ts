import { assert } from "@std/assert";
import { join } from "@std/path";
import { runDenoCheckWithTemporaryConfig } from "@commonfabric/test-support/isolated-deno";

const ROOT = join(import.meta.dirname!, "..", "..", "..");

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

Deno.test("shell view slice type-checks under standard decorators", async () => {
  const rootConfigPath = join(ROOT, "deno.json");
  const rootConfig = JSON.parse(await Deno.readTextFile(rootConfigPath));

  rootConfig.compilerOptions ??= {};
  rootConfig.compilerOptions.experimentalDecorators = false;

  const files = [
    "packages/iframe-sandbox/src/common-iframe-sandbox.ts",
    "packages/shell/src/views/ACLView.ts",
    "packages/shell/src/views/AppView.ts",
    "packages/shell/src/views/BodyView.ts",
    "packages/shell/src/views/DebuggerView.ts",
    "packages/shell/src/views/HeaderView.ts",
    "packages/shell/src/views/LoginView.ts",
    "packages/shell/src/views/QuickJumpView.ts",
    "packages/shell/src/views/RootView.ts",
    "packages/shell/src/views/SchedulerGraphView.ts",
    "packages/shell/src/views/SchedulerSourceView.ts",
    "packages/shell/src/views/_PieceView.ts",
  ];

  const output = await runDenoCheckWithTemporaryConfig({
    root: ROOT,
    config: rootConfig,
    files,
    tempConfigPrefix: "deno.standard-decorators.shell-views",
  });

  if (!output.success) {
    console.error(decode(output.stdout));
    console.error(decode(output.stderr));
  }

  assert(
    output.success,
    "shell view slice should pass under standard decorators",
  );
});
