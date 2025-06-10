import { type Program } from "../interface.ts";

export enum CommandType {
  Run = "run",
  Help = "help",
}

export interface Args {
  entry?: string;
  help?: boolean;
  verbose?: boolean;
  noRun?: boolean;
  noCheck?: boolean;
  filename?: string;
  output?: string;
}

export interface Command {
  type: CommandType;
  verbose?: boolean;
}

export interface RunCommand extends Command {
  type: CommandType.Run;
  entry: string;
  verbose?: boolean;
  noRun?: boolean;
  noCheck?: boolean;
  filename?: string;
  output?: string;
}
