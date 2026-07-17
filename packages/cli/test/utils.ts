import { decode, encode } from "@commonfabric/utils/encoding";
import { join } from "@std/path";
import { expect } from "@std/expect/expect";

// Decodes a `Uint8Array` into an array of strings for each line.
export function bytesToLines(stream: Uint8Array): string[] {
  return decode(stream).split("\n").filter(Boolean);
}

// deno-lint-ignore no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*m/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

export function isIgnorableDenoWarningLine(line: string): boolean {
  const trimmed = stripAnsi(line).trimStart();
  return trimmed.startsWith(
    "Warning The following peer dependency issues were found:",
  ) ||
    trimmed.startsWith("╭ Warning") ||
    trimmed.startsWith("╰─") ||
    trimmed.startsWith("│") ||
    // Deno prints one of these per module it fetches whenever the module cache
    // is cold, which happens on a fresh machine and after any change that
    // invalidates the cache, such as a Deno version bump.
    trimmed.startsWith("Download ") ||
    /^[└├]/u.test(trimmed);
}

export function checkStderr(stderr: string[]) {
  const relevant = stderr.filter((line) => !isIgnorableDenoWarningLine(line));
  try {
    expect(relevant.length).toBe(1);
  } catch (e) {
    console.error(stderr);
    throw e;
  }
  expect(relevant[0]).toMatch(/deno run /);
}

export interface CliResult {
  code: number;
  stdout: string[];
  stderr: string[];
}

// Splits a command string into arguments on spaces outside of double quotes,
// then strips the quotes.
function parseCliCommand(command: string): string[] {
  const match = command.match(/(?:[^\s"]+|"[^"]*")+/g);
  if (!match || match.length === 0) {
    throw new Error(`Could not parse command: ${command}.`);
  }
  return match.map((arg) => arg.replace(/"/g, ""));
}

async function spawnCli(
  executable: string,
  args: string[],
  stdin?: string,
): Promise<CliResult> {
  const child = new Deno.Command(executable, {
    cwd: join(import.meta.dirname!, ".."),
    args,
    // `.output()` requires stdout/stderr to be piped; `.spawn()` would
    // otherwise default them to "inherit".
    stdout: "piped",
    stderr: "piped",
    stdin: stdin === undefined ? "null" : "piped",
  }).spawn();

  if (stdin !== undefined) {
    const writer = child.stdin.getWriter();
    await writer.write(encode(stdin));
    await writer.close();
  }

  const { code, stdout, stderr } = await child.output();
  return {
    code,
    stdout: bytesToLines(stdout),
    stderr: bytesToLines(stderr),
  };
}

async function runCliTask(
  task: "cli-no-pwd-override",
  command: string,
  stdin?: string,
): Promise<CliResult> {
  return await spawnCli(
    Deno.execPath(),
    [
      "task",
      // Deno tasks run with PWD set to wherever the deno.jsonc manifest is.
      // The `cli` task in this package overrides that to use the shell's PWD.
      // As these tests run within a test task, we can't override that PWD.
      // For tests, use a version of the cli task that does *not* override
      // user/deno's PWD.
      task,
      ...parseCliCommand(command),
    ],
    stdin,
  );
}

// Executes the `cf` command via CLI
// `const { stdout, stderr, code } = cf("dev --no-run ./pattern.tsx")`
// Pass `stdin` to feed the command's standard input.
export async function cf(
  command: string,
  stdin?: string,
): Promise<CliResult> {
  return await runCliTask("cli-no-pwd-override", command, stdin);
}

let cfBinaryProbe: Promise<boolean> | undefined;

// True when integration tests should run the prebuilt `cf` binary from PATH:
// CF_CLI_INTEGRATION_USE_LOCAL is unset (the same override integration.sh
// honors) and a `cf` on PATH answers `id --help`, a subcommand other tools
// that install a `cf` binary reject. Probed once per process.
function cfBinaryAvailable(): Promise<boolean> {
  cfBinaryProbe ??= (async () => {
    if (Deno.env.get("CF_CLI_INTEGRATION_USE_LOCAL")) {
      return false;
    }
    try {
      const { success } = await new Deno.Command("cf", {
        args: ["id", "--help"],
        stdout: "null",
        stderr: "null",
        stdin: "null",
      }).output();
      return success;
    } catch {
      return false;
    }
  })();
  return cfBinaryProbe;
}

// Executes the `cf` command for integration tests: the prebuilt `cf` binary
// from PATH when one is available (as in the CI integration jobs, which put
// the built binaries on PATH), the source-tree CLI task otherwise. Set
// CF_CLI_INTEGRATION_USE_LOCAL=1 to force the source-tree CLI.
export async function integrationCf(
  command: string,
  stdin?: string,
): Promise<CliResult> {
  if (await cfBinaryAvailable()) {
    return await spawnCli("cf", parseCliCommand(command), stdin);
  }
  return await cf(command, stdin);
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
