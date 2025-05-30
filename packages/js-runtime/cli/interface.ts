import { type TsArtifact } from "../interface.ts";

export enum CommandType {
  Run = "run",
  Help = "help",
}

export interface Args {
  files: string[];
  help?: boolean;
  verbose?: boolean;
  noRun?: boolean;
  noCheck?: boolean;
  out?: string;
}

export interface Command {
  type: CommandType;
  verbose?: boolean;
}

export interface RunCommand extends Command {
  type: CommandType.Run;
  source: TsArtifact;
  verbose?: boolean;
  noRun?: boolean;
  noCheck?: boolean;
  out?: string;
}
