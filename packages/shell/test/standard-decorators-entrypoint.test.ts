import { assert } from "@std/assert";
import { join } from "@std/path";

const ROOT = join(import.meta.dirname!, "..", "..", "..");

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

Deno.test("shell entrypoint type-checks under standard decorators", async () => {
  const rootConfig = JSON.parse(
    await Deno.readTextFile(join(ROOT, "deno.json")),
  );
  const packageConfig = JSON.parse(
    await Deno.readTextFile(join(ROOT, "packages", "shell", "deno.json")),
  );

  rootConfig.compilerOptions ??= {};
  rootConfig.compilerOptions.experimentalDecorators = false;
  rootConfig.imports = {
    ...(rootConfig.imports ?? {}),
    ...(packageConfig.imports ?? {}),
  };

  const tempConfig = join(
    ROOT,
    ".deno.standard-decorators.shell-entrypoint.json",
  );
  await Deno.writeTextFile(tempConfig, JSON.stringify(rootConfig, null, 2));

  const output = await new Deno.Command(Deno.execPath(), {
    cwd: ROOT,
    args: ["check", "--config", tempConfig, "packages/shell/src/index.ts"],
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
    "shell entrypoint should pass under standard decorators",
  );
});
