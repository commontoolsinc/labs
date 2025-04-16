export enum CommandType {
  New,
  Extend,
  Other,
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
};

export type Scenario = {
  name: string;
  steps: Step[];
};
