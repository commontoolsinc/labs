import { populateArtifact, relativeToAbsolute } from "./utils.ts";
import {
  Args,
  type Command,
  CommandType,
  type RunCommand,
} from "./interface.ts";
import { Processor } from "./processor.ts";
import { parseArgs } from "@std/cli/parse-args";

export class RuntimeCLI {
  private cwd: string;
  private processor: Processor;
  constructor(cwd: string = Deno.cwd()) {
    this.cwd = cwd;
    this.processor = new Processor();
  }

  async parse(input: string[]): Promise<Command> {
    const args = parseCLIArgs(this.cwd, input);
    if (args.help) {
      return { type: CommandType.Help };
    }

    const runCommand: RunCommand = {
      type: CommandType.Run,
      source: await populateArtifact(args.files),
    };
    if (args.noCheck) runCommand.noCheck = args.noCheck;
    if (args.noRun) runCommand.noRun = args.noRun;
    if (args.verbose) runCommand.verbose = args.verbose;
    if (args.out) runCommand.out = args.out;
    return runCommand;
  }

  async process(command: Command): Promise<any> {
    switch (command.type) {
      case CommandType.Help: {
        console.log("HELP TEXT");
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
      "help",
      "verbose",
      "no-run",
      "no-check",
    ],
    string: [
      "out",
    ],
  });

  return {
    files: (parsed["_"] ?? []).map((filepath) =>
      relativeToAbsolute(cwd, String(filepath))
    ),
    help: !!parsed.help,
    verbose: !!parsed.verbose,
    noCheck: !!parsed["no-check"],
    noRun: !!parsed["no-run"],
    out: parsed.out ? relativeToAbsolute(cwd, parsed.out) : undefined,
  };
}
