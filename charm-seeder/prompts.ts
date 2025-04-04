import { CommandType } from "./commands.ts";

export const scenarios = [{
  type: CommandType.New,
  prompt: "a 2048 game",
}, {
  type: CommandType.New,
  prompt: "2048 game",
}, {
  type: CommandType.New,
  prompt: "todo list",
}, {
  type: CommandType.New,
  prompt: "create json to describe 25 mexican meal recipes",
}, {
  type: CommandType.New,
  prompt:
    "i'd like to keep a shopping list.  let me import from markdown with existing selections.  keep it clean and simple!",
}];
