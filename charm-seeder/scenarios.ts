import { CommandType } from "./commands.ts";

export type Step = {
  type: CommandType;
  prompt: string;
};

export type Scenario = {
  steps: Step[];
};

export const scenarios: Scenario[] = [
  // {
  //   steps: [{
  //     type: CommandType.New,
  //     prompt: "a 2048 game",
  //   }],
  // }, {
  //   steps: [{
  //     type: CommandType.New,
  //     prompt: "2048 game",
  //   }],
  // }, {
  //   steps: [
  //     {
  //       type: CommandType.New,
  //       prompt: "todo list",
  //     },
  //   ],
  // },
  // {
  //   steps: [{
  //     type: CommandType.New,
  //     prompt: "create json to describe 25 mexican meal recipes",
  //   }],
  // },
  {
    steps: [{
      type: CommandType.New,
      prompt: "create json to describe 25 mexican meal recipes",
    }, {
      type: CommandType.Extend,
      prompt: "let me create a shopping list from selected recipes",
    }],
  },
  //  {
  //   steps: [{
  //     type: CommandType.New,
  //     prompt:
  //       "i'd like to keep a shopping list.  let me import from markdown with existing selections.  keep it clean and simple!",
  //   }],}
];
