import { type ConsoleHandler } from "@commonfabric/runner";
import { NodeConsole, Writable } from "./deps.ts";

const textEncoder = new TextEncoder();
const stderrStream = new Writable({
  write(chunk, _encoding, callback) {
    try {
      const bytes = typeof chunk === "string"
        ? textEncoder.encode(chunk)
        : chunk;
      Deno.stderr.writeSync(bytes);
      callback();
    } catch (error) {
      callback(error instanceof Error ? error : new Error(String(error)));
    }
  },
});
const stderrConsole = new NodeConsole({
  stdout: stderrStream,
  stderr: stderrStream,
}) as unknown as Console;
stderrConsole.timeStamp = () => {};

export function hasJsonArgument(args: readonly string[]): boolean {
  return args.some((arg) =>
    arg === "--json" || arg.startsWith("--json=") ||
    arg === "--json-file" || arg.startsWith("--json-file=")
  );
}

const pieceGlobalValueOptions = new Set([
  "-u",
  "--url",
  "-a",
  "--api-url",
  "-i",
  "--identity",
  "-s",
  "--space",
]);

function pieceSubcommand(args: readonly string[]): string | undefined {
  if (args[0] !== "piece") return undefined;

  for (let index = 1; index < args.length; index++) {
    const argument = args[index];
    if (argument === "-q" || argument === "--quiet") continue;

    const equalsIndex = argument.indexOf("=");
    const option = equalsIndex === -1
      ? argument
      : argument.slice(0, equalsIndex);
    if (pieceGlobalValueOptions.has(option)) {
      if (equalsIndex === -1) index++;
      continue;
    }
    if (/^-[uais].+/.test(argument)) continue;
    if (argument === "--") return undefined;
    if (argument.startsWith("-")) continue;
    return argument;
  }

  return undefined;
}

export function reservesStdoutForCommandOutput(
  args: readonly string[],
): boolean {
  if (
    hasJsonArgument(args) ||
    args.some((arg) =>
      arg === "--pattern-json" || arg.startsWith("--pattern-json=") ||
      arg === "--show-transformed" || arg.startsWith("--show-transformed=")
    )
  ) {
    return true;
  }
  if (args[0] === "exec") return true;
  if (args[0] === "wish") return true;
  const subcommand = pieceSubcommand(args);
  return subcommand === "get" || subcommand === "call";
}

export const stderrConsoleHandler: ConsoleHandler = ({ method, args }) => ({
  target: stderrConsole,
  method,
  args,
});
