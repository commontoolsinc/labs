import { decode } from "@commontools/utils/encoding";
import { join } from "@std/path";

// Decodes a `Uint8Array` into an array of strings for each line.
export function bytesToLines(stream: Uint8Array): string[] {
  return decode(stream).split("\n").filter(Boolean);
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
      "cli",
      ...args,
    ],
  }).output();
  return {
    code,
    stdout: bytesToLines(stdout),
    stderr: bytesToLines(stderr),
  };
}
