import { CommandType } from "./commands.ts";

export type Step = {
  type: CommandType;
  prompt: string;
};

export type Scenario = {
  name: string;
  steps: Step[];
};

export const scenarios: Scenario[] = [
  {
    name: "2048 Game Long",
    steps: [{
      type: CommandType.New,
      prompt: "a 2048 game",
    }],
  },
  {
    name: "2048 Game Short",
    steps: [{
      type: CommandType.New,
      prompt: "2048 game",
    }],
  },
  {
    name: "Todo List",
    steps: [
      {
        type: CommandType.New,
        prompt: "todo list",
      },
    ],
  },
  {
    name: "Mexican Recipes",
    steps: [{
      type: CommandType.New,
      prompt: "create json to describe 25 mexican meal recipes",
    }],
  },
  {
    name: "Mexican Recipes with Shopping List",
    steps: [{
      type: CommandType.New,
      prompt: "create json to describe 25 mexican meal recipes",
    }, {
      type: CommandType.Extend,
      prompt: "let me create a shopping list from selected recipes",
    }],
  },
  {
    name: "Shopping List",
    steps: [{
      type: CommandType.New,
      prompt:
        "i'd like to keep a shopping list.  let me import from markdown with existing selections.  keep it clean and simple!",
    }],
  },
  {
    name: "Summer Camp Coordination",
    steps: [{
      type: CommandType.New,
      prompt:
        `this is a summer coordination calendar, make it clean like an apple interface. 

it shows variable 3 compact month views at the top (default June, July, August 2025) and allows participants (default Zora) to pick a color and indicate their availability for a given activity. 

when new activities are added, all participants see them and can add their availability. when creating a new activity the active user can specify details like title, description, location, and duration. when a given user is in control, the other users colors become lighter shades, and they click calendar dates to indicate their availability with a colored circle. when a day is selected by multiple participants, place the active participant color behind the others and divide the colors evenly (like a pie chart) to show them all within the circle.

Recommend the 3 best timeframes for the trip based on degree of overlap relative to the activity duration. if there is any overlap, outline the best dates in black.

double clicking toggles the entire week's availability (Sunday through Saturday)

default participants: zora, casey, lauren

default activities: Summer Camp (duration 5 days), Monterey Bay Aquarium (duration 1 day), Lake Tahoe (duration 3 days), Beach Day (duration 1 day), Zoo (duration 1 day) 

make it easy to rename and edit activities.

make it minimal and apple-like UI.`,
    }],
  },
];
