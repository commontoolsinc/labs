import {
  Args,
  type Command,
  CommandType,
  type RunCommand,
} from "./interface.ts";
import { Processor } from "./processor.ts";
import { parseArgs } from "@std/cli/parse-args";
import { join } from "@std/path";
import { help } from "./help.ts";

export class RuntimeCLI {
  private cwd: string;
  private processor: Processor;
  constructor(cwd: string = Deno.cwd()) {
    this.cwd = cwd;
    this.processor = new Processor();
  }

  parse(input: string[]): Command {
    const args = parseCLIArgs(this.cwd, input);
    if (args.help) {
      return { type: CommandType.Help };
    }

    if (!args.entry) {
      throw new Error("Missing entry.");
    }
    const runCommand: RunCommand = {
      type: CommandType.Run,
      entry: args.entry,
    };
    if (args.noCheck) runCommand.noCheck = args.noCheck;
    if (args.noRun) runCommand.noRun = args.noRun;
    if (args.verbose) runCommand.verbose = args.verbose;
    if (args.filename) runCommand.filename = args.filename;
    if (args.output) runCommand.output = args.output;
    return runCommand;
  }

  async process(command: Command): Promise<any> {
    switch (command.type) {
      case CommandType.Help: {
        console.log(help);
        return;
      }
      case CommandType.Run: {
        return await this.processor.run(command as RunCommand);
      }
      default: {
        throw new Error("Invalid command.");
      }
    }
  }
}

export function parseCLIArgs(cwd: string, input: string[]): Args {
  const parsed = parseArgs(input, {
    boolean: [
      "h",
      "help",
      "v",
      "verbose",
      "no-run",
      "no-check",
    ],
    string: [
      "f",
      "filename",
      "o",
      "output",
    ],
  });

  const help = !!(parsed.h || parsed.help);
  const verbose = !!(parsed.v || parsed.verbose);
  const filename = parsed.filename || parsed.f;
  const output = parsed.output || parsed.o;
  const entry = (parsed["_"] ?? []).shift();
  const noCheck = !!parsed["no-check"];
  const noRun = !!parsed["no-run"];

  return {
    entry: entry ? relativeToAbsolute(cwd, String(entry)) : undefined,
    filename: filename ? relativeToAbsolute(cwd, filename) : undefined,
    help,
    noCheck,
    noRun,
    output,
    verbose,
  };
}

function relativeToAbsolute(rootDir: string, filepath: string): string {
  return join(rootDir, filepath);
}
