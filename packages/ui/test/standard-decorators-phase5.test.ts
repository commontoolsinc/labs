import { assert } from "@std/assert";
import { join } from "@std/path";

const ROOT = join(import.meta.dirname!, "..", "..", "..");

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

Deno.test("secondary transitive ui slice type-checks under standard decorators", async () => {
  const rootConfigPath = join(ROOT, "deno.json");
  const rootConfig = JSON.parse(await Deno.readTextFile(rootConfigPath));

  rootConfig.compilerOptions ??= {};
  rootConfig.compilerOptions.experimentalDecorators = false;

  const tempConfig = join(ROOT, ".deno.standard-decorators.ui-phase5.json");
  await Deno.writeTextFile(tempConfig, JSON.stringify(rootConfig, null, 2));

  const files = [
    "packages/ui/src/v2/components/cf-cell-link/cf-cell-link.ts",
    "packages/ui/src/v2/components/cf-chat-message/cf-chat-message.ts",
    "packages/ui/src/v2/components/cf-chat/cf-chat.ts",
    "packages/ui/src/v2/components/cf-markdown/cf-markdown.ts",
    "packages/ui/src/v2/components/cf-question/cf-question.ts",
    "packages/ui/src/v2/components/cf-radio-group/cf-radio-group.ts",
    "packages/ui/src/v2/components/cf-render/cf-render.ts",
    "packages/ui/src/v2/components/cf-router/cf-link.ts",
    "packages/ui/src/v2/components/cf-space-link/cf-space-link.ts",
    "packages/ui/src/v2/components/cf-svg/cf-svg.ts",
    "packages/ui/src/v2/components/cf-textarea/cf-textarea.ts",
    "packages/ui/src/v2/components/cf-theme/cf-theme.ts",
    "packages/ui/src/v2/components/cf-tool-call/cf-tool-call.ts",
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
    "secondary transitive ui slice should pass under standard decorators",
  );
});
