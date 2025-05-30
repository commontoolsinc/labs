export enum CommandType {
  New,
  Extend,
  Other,
  ImportJSON,
  LoadRecipe,
}
export type Step = {
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
  dataSchema?: any;
} | {
  type: CommandType.LoadRecipe;
  name: string;
  prompt: string;
  recipe: string;
};

export type CharmResult = {
  id: string | null;
  prompt: string;
  screenshotPath?: string;
  status: "PASS" | "FAIL" | "NOTVERIFIED";
  summary: string;
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
