import { decode } from "@commontools/utils/encoding";
import { join } from "@std/path";
import { expect } from "@std/expect/expect";

// Decodes a `Uint8Array` into an array of strings for each line.
export function bytesToLines(stream: Uint8Array): string[] {
  return decode(stream).split("\n").filter(Boolean);
}

export function checkStderr(stderr: string[]) {
  try {
    expect(stderr.length).toBe(2);
  } catch (e) {
    console.error(stderr);
    throw e;
  }
  expect(stderr[0]).toMatch(/deno run /);
  expect(stderr[1]).toMatch(/experimentalDecorators compiler option/);
}

// Executes the `ct` command via CLI
// `const { stdout, stderr, code } = ct("dev --no-run ./recipe.tsx")`
export async function ct(
  command: string,
): Promise<{ code: number; stdout: string[]; stderr: string[] }> {
  // Use a regex to split up spaces outside of quotes.
  const match = command.match(/(?:[^\s"]+|"[^"]*")+/g);
  if (!match || match.length === 0) {
    throw new Error(`Could not parse command: ${command}.`);
  }
  // Filter out quotes that are in strings
  const args = match.map((arg) => arg.replace(/"/g, ""));

  const { code, stdout, stderr } = await new Deno.Command(Deno.execPath(), {
    cwd: join(import.meta.dirname!, ".."),
    args: [
      "task",
      // Deno tasks run with PWD set to wherever the deno.json manifest is.
      // The `cli` task in this package overrides that to use the shell's PWD.
      // As these tests run within a test task, we can't override that PWD.
      // For tests, use a version of the cli task that does *not* override
      // user/deno's PWD.
      "cli-no-pwd-override",
      ...args,
    ],
  }).output();
  return {
    code,
    stdout: bytesToLines(stdout),
    stderr: bytesToLines(stderr),
  };
}
