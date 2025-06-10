export enum CommandType {
  Help = "help",
  Init = "init",
  Run = "run",
}

export function isCommandType(value: unknown): value is CommandType {
  return value === "help" || value === "init" || value === "run";
}

export interface Args {
  command: CommandType;
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
  cwd: string;
  verbose?: boolean;
}

export interface RunCommand extends Command {
  type: CommandType.Run;
  cwd: string;
  verbose?: boolean;
  entry: string;
  noRun?: boolean;
  noCheck?: boolean;
  filename?: string;
  output?: string;
}
