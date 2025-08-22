import { JSONSchema } from "@commontools/runner";

export enum CommandType {
  New,
  Extend,
  Other,
  ImportJSON,
}
export type Command = {
  type: CommandType.New;
  prompt: string;
} | {
  type: CommandType.Other;
  prompt: string;
} | {
  type: CommandType.Extend;
  prompt: string;
} | {
  type: CommandType.ImportJSON;
  prompt: string;
  data: unknown;
};

export type CharmResult = {
  id: string | null;
  prompt: string;
  screenshotPath?: string;
  status: "PASS" | "FAIL" | "NOTVERIFIED";
  summary: string;
};

export type Step = {
  type: CommandType;
  prompt: string;
  data?: Record<string, unknown>;
  dataSchema?: JSONSchema;
};

export type Scenario = {
  name: string;
  steps: Step[];
  tags?: string[];
};

export interface ExecutedScenario {
  scenario: Scenario;
  results: CharmResult[];
}
