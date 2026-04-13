import { assert } from "@std/assert";
import { join } from "@std/path";

const ROOT = join(import.meta.dirname!, "..", "..", "..");

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

Deno.test("shell view slice type-checks under standard decorators", async () => {
  const rootConfigPath = join(ROOT, "deno.json");
  const rootConfig = JSON.parse(await Deno.readTextFile(rootConfigPath));

  rootConfig.compilerOptions ??= {};
  rootConfig.compilerOptions.experimentalDecorators = false;

  const tempConfig = join(ROOT, ".deno.standard-decorators.shell-views.json");
  await Deno.writeTextFile(tempConfig, JSON.stringify(rootConfig, null, 2));

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
    "shell view slice should pass under standard decorators",
  );
});
