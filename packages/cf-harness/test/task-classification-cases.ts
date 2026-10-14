import type {
  HarnessTaskTag,
  TaskClassificationContext,
} from "../src/task-classification.ts";

/** One ask, what the job held when it was typed, and the tags it called for. */
export interface TaskClassificationCase {
  task: string;
  context: TaskClassificationContext;
  expected: HarnessTaskTag[];
}

const cell = (name: string) => ({
  name,
  token: `cfh:a:${name.toLowerCase().replaceAll(" ", "-")}`,
  ref: `of:fid1:${name.length}`,
});

/**
 * The asks of the 2026-10-13 playtest, as typed on its sheet, labelled by the
 * kinds of work each one's job did or should have done.
 */
const pomodoroPanel = { inputCells: [cell("Pomodoro Timer")] };
export const PLAYTEST_2026_10_13_TASKS: readonly TaskClassificationCase[] = [
  {
    task: "take me to the lunch poll loom",
    context: pomodoroPanel,
    expected: ["act", "find"],
  },
  {
    task: "take me to the gardening project loom",
    context: pomodoroPanel,
    expected: ["act", "find"],
  },
  {
    task: "take me to the quarterly budget loom",
    context: pomodoroPanel,
    expected: ["act", "find"],
  },
  {
    task: "take me to the lunh pol loom",
    context: pomodoroPanel,
    expected: ["act", "find"],
  },
  {
    task: "open the loom for this meeting",
    context: { inputCells: [cell("Team Sync")] },
    expected: ["act", "find", "pieces"],
  },
  {
    task: "when am I next meeting Alex?",
    context: pomodoroPanel,
    expected: ["find"],
  },
  { task: "what's on Thursday?", context: {}, expected: ["find"] },
  { task: "who haven't I replied to?", context: {}, expected: ["find"] },
  {
    task: "find that email from Anthropic",
    context: pomodoroPanel,
    expected: ["find"],
  },
  { task: "what's on Saturday?", context: {}, expected: ["find"] },
  {
    task: "summarise everything in my inbox this week",
    context: {},
    expected: ["find"],
  },
  {
    task: "take me to the dinner ideas loom",
    context: {},
    expected: ["act", "find"],
  },
  {
    task: "when is my next team sync?",
    context: {},
    expected: ["find"],
  },
  {
    task: "list the available options from the lunch poll",
    context: { inputCells: [cell("Team Lunch Poll")] },
    expected: ["pieces"],
  },
  {
    task: "what is this loom about?",
    context: { inputCells: [cell("FabriChat")] },
    expected: ["find"],
  },
  {
    task: "find a packing-list pattern and add it to this loom",
    context: {},
    expected: ["act", "find"],
  },
  { task: "make me a pomodoro timer", context: {}, expected: ["author"] },
  {
    task: "add socks to my packing list",
    context: { inputCells: [cell("Packing List")] },
    expected: ["pieces"],
  },
  {
    task: "make me a word guessing game pattern",
    context: pomodoroPanel,
    expected: ["author"],
  },
  {
    task: "find and deploy pomodoro timer pattern",
    context: {},
    expected: ["act", "find"],
  },
  {
    task: "set it to 10 minutes",
    context: pomodoroPanel,
    expected: ["pieces"],
  },
];
