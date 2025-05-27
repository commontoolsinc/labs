import { type TsArtifact } from "../interface.ts";

export enum CommandType {
  Run = "run",
  Help = "help",
}

export interface Command {
  type: CommandType;
  verbose?: boolean;
}

export interface RunCommand extends Command {
  type: CommandType.Run;
  source: TsArtifact;
  bundle?: boolean;
}