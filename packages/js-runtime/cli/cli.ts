import * as path from "@std/path";
import { populateArtifact } from "./utils.ts";
import { type Command, CommandType, type RunCommand } from "./interface.ts";
import { Processor } from "./processor.ts";

type CLIArg = "verbose" | "help" | "no-run" | "bundle";
type CLIArgs = Record<CLIArg, boolean>;

const CLIFlags: Map<string, CLIArg> = new Map([
  ["-v", "verbose"],
  ["--verbose", "verbose"],
  ["-h", "help"],
  ["--h", "help"],
  ["--help", "help"],
  ["--bundle", "bundle"],
  ["--no-run", "no-run"],
]);

export class RuntimeCLI {
  private cwd: string;
  private processor: Processor;
  constructor(cwd: string = Deno.cwd()) {
    this.cwd = cwd;
    this.processor = new Processor();
  }

  async parse(input: string[]): Promise<Command> {
    type CLIArgsExtra = CLIArgs & {
      others?: string[];
    };
    const args = input.reduce((args, arg) => {
      const match = CLIFlags.get(arg);
      if (match) {
        args[match] = true;
      } else {
        if (!args.others) {
          args.others = [];
        }
        args.others.push(arg);
      }
      return args;
    }, {} as CLIArgsExtra);

    if (args.help) {
      return { type: CommandType.Help };
    }

    const runCommand: RunCommand = {
      type: CommandType.Run,
      source: await populateArtifact(this.cwd, args.others ?? []),
    };
    if (args.bundle) runCommand.bundle = true;
    if (args.verbose) runCommand.verbose = true;
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