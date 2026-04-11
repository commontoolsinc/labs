import { decode } from "@commonfabric/utils/encoding";
import { join } from "@std/path";
import { expect } from "@std/expect/expect";

// Decodes a `Uint8Array` into an array of strings for each line.
export function bytesToLines(stream: Uint8Array): string[] {
  return decode(stream).split("\n").filter(Boolean);
}

export function isIgnorableDenoWarningLine(line: string): boolean {
  const trimmed = line.trimStart();
  return trimmed.startsWith(
    "Warning The following peer dependency issues were found:",
  ) ||
    trimmed.startsWith("╭ Warning") ||
    trimmed.startsWith("╰─") ||
    trimmed.startsWith("│") ||
    /^[└├]/u.test(trimmed);
}

export function checkStderr(stderr: string[]) {
  const relevant = stderr.filter((line) =>
    !isIgnorableDenoWarningLine(line) && /deno run /.test(line)
  );
  try {
    expect(relevant.length).toBe(1);
  } catch (e) {
    console.error(stderr);
    throw e;
  }
  expect(relevant[0]).toMatch(/deno run /);
}

async function runCliTask(
  task: "cli-no-pwd-override",
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
      task,
      ...args,
    ],
  }).output();
  return {
    code,
    stdout: bytesToLines(stdout),
    stderr: bytesToLines(stderr),
  };
}

// Executes the `cf` command via CLI
// `const { stdout, stderr, code } = cf("dev --no-run ./pattern.tsx")`
export async function cf(
  command: string,
): Promise<{ code: number; stdout: string[]; stderr: string[] }> {
  return await runCliTask("cli-no-pwd-override", command);
}

export async function withEnv(
  name: string,
  value: string | undefined,
  fn: () => Promise<void> | void,
): Promise<void> {
  const previous = Deno.env.get(name);
  if (value === undefined) {
    Deno.env.delete(name);
  } else {
    Deno.env.set(name, value);
  }

  try {
    await fn();
  } finally {
    if (previous === undefined) {
      Deno.env.delete(name);
    } else {
      Deno.env.set(name, previous);
    }
  }
}
