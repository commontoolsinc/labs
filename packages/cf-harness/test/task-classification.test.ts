import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import type { HarnessPatternRef } from "../src/contracts/pattern-refs.ts";
import {
  classifyTask,
  classifyTaskByRule,
  HARNESS_TASK_TAGS,
  type HarnessTaskTag,
  type TaskClassificationContext,
} from "../src/task-classification.ts";

const cell = (name: string) => ({
  name,
  token: `cfh:a:${name.toLowerCase().replaceAll(" ", "-")}`,
  ref: `of:fid1:${name.length}`,
});

const tagsOf = (tags: ReadonlySet<HarnessTaskTag> | undefined) =>
  tags === undefined ? undefined : [...tags].sort();

describe("task-classification", () => {
  describe("classifyTaskByRule()", () => {
    it("returns respond for short conversational text", () => {
      expect(tagsOf(classifyTaskByRule("thanks!", {}))).toEqual(["respond"]);
    });

    it("returns pieces for an attached pattern ref", () => {
      expect(tagsOf(classifyTaskByRule("Rename it.", {
        patternRefs: [
          {
            patternId: "v6_KSFHs9AmTg9PKwMmPdZyEHxZ9Oykhno4HBOfUo5s",
          } as HarnessPatternRef,
        ],
      }))).toEqual(["pieces"]);
    });

    it("returns pieces for a request naming a held input cell", () => {
      expect(tagsOf(classifyTaskByRule("add socks to my packing list", {
        inputCells: [cell("Packing List")],
      }))).toEqual(["pieces"]);
    });

    it("returns find and act for navigation to a loom", () => {
      expect(tagsOf(classifyTaskByRule("take me to the lunch poll loom", {})))
        .toEqual(["act", "find"]);
    });

    it("returns find for a question", () => {
      expect(tagsOf(classifyTaskByRule("what's on Thursday?", {})))
        .toEqual(["find"]);
    });

    it("returns find for a URL", () => {
      expect(
        tagsOf(classifyTaskByRule("https://example.com/menu dinner", {})),
      ).toEqual(["find"]);
    });

    it("returns author for a request to make something new", () => {
      expect(tagsOf(classifyTaskByRule("make me a pomodoro timer", {})))
        .toEqual(["author"]);
    });

    it("returns act for a web purchase when a browser is attached", () => {
      expect(
        tagsOf(
          classifyTaskByRule("buy the cheapest oat milk", {
            browserHost: true,
          }),
        ),
      ).toEqual(["act"]);
    });

    it("returns undefined when no rule applies", () => {
      expect(classifyTaskByRule("the quarterly numbers for Q3 sales", {}))
        .toBeUndefined();
    });
  });

  describe("classifyTask()", () => {
    it("records the rule path without asking the model when a rule applies", async () => {
      let asked = 0;
      const classification = await classifyTask("what's on Thursday?", {}, {
        askModel: () => {
          asked += 1;
          return Promise.resolve("respond");
        },
      });

      expect(asked).toBe(0);
      expect(classification.path).toBe("rule");
      expect(classification.tags).toEqual(["find"]);
      expect(classification.durationMs).toBeGreaterThanOrEqual(0);
    });

    it("asks the model when no rule applies and records its tags", async () => {
      const prompts: string[] = [];
      const classification = await classifyTask(
        "the quarterly numbers for Q3 sales",
        { inputCells: [cell("Budget")] },
        {
          askModel: (prompt) => {
            prompts.push(prompt);
            return Promise.resolve("find, pieces");
          },
        },
      );

      expect(classification.path).toBe("model");
      expect(classification.tags).toEqual(["find", "pieces"]);
      expect(prompts[0]).toContain("the quarterly numbers for Q3 sales");
      expect(prompts[0]).toContain("Budget");
    });

    it("falls back to every tag when the model answers no tag", async () => {
      const classification = await classifyTask(
        "the quarterly numbers for Q3 sales",
        {},
        { askModel: () => Promise.resolve("I am not sure.") },
      );

      expect(classification.path).toBe("fallback");
      expect(classification.tags).toEqual([...HARNESS_TASK_TAGS]);
    });

    it("falls back to every tag when the model call fails", async () => {
      const classification = await classifyTask(
        "the quarterly numbers for Q3 sales",
        {},
        { askModel: () => Promise.reject(new Error("provider down")) },
      );

      expect(classification.path).toBe("fallback");
      expect(classification.tags).toEqual([...HARNESS_TASK_TAGS]);
    });

    it("falls back to every tag when no model is available", async () => {
      const classification = await classifyTask(
        "the quarterly numbers for Q3 sales",
        {},
      );

      expect(classification.path).toBe("fallback");
      expect(classification.tags).toEqual([...HARNESS_TASK_TAGS]);
    });
  });

  describe("the playtest asks of 2026-10-13", () => {
    // Each ask as typed on the playtest sheet, with what the job held, and
    // the tags its work called for. The rule must answer every one well
    // inside the time a model call would take.

    const pomodoroPanel = { inputCells: [cell("Pomodoro Timer")] };
    const cases: {
      task: string;
      context: TaskClassificationContext;
      expected: HarnessTaskTag[];
    }[] = [
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

    for (const { task, context, expected } of cases) {
      it(`returns ${expected.join(", ")} for ${JSON.stringify(task)}`, () => {
        expect(tagsOf(classifyTaskByRule(task, context))).toEqual(expected);
      });
    }

    it("answers the whole set by rule in well under 100 ms", () => {
      const started = performance.now();
      for (const { task, context } of cases) {
        classifyTaskByRule(task, context);
      }

      expect(performance.now() - started).toBeLessThan(100);
    });
  });
});
