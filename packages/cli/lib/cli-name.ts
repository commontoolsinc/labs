import { basename } from "@std/path";

export function cliName(
  options: { envName?: string | undefined; execPath?: string | undefined } = {},
): string {
  const envName = options.envName ?? Deno.env.get("CF_CLI_NAME");
  if (envName?.trim()) {
    return envName.trim();
  }

  const execBase = basename(options.execPath ?? Deno.execPath()).toLowerCase();
  if (execBase === "ct" || execBase === "ct.exe") {
    return "ct";
  }

  return "cf";
}

export function cliCommand(parts: Iterable<string>, name = cliName()): string {
  return [name, ...parts].join(" ");
}

export function cliText(text: string, name = cliName()): string {
  return text.replaceAll(/(^|[\s"'`(])cf(?=\s)/gm, `$1${name}`);
}
