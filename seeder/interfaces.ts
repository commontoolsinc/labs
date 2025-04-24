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
  data: any;
};

export type CharmResult = {
  id: string;
  prompt: string;
  screenshotPath: string;
  status: string;
  summary: string;
};

export type Step = {
  type: CommandType;
  prompt: string;
  data?: any;
  dataSchema?: any;
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
