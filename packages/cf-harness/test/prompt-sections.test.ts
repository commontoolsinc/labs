import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { HARNESS_RUN_DEPTHS } from "../src/contracts/run-depth.ts";
import {
  PROMPT_SECTIONS,
  type RunShape,
  sendsSection,
} from "../src/prompt-sections.ts";
import {
  HARNESS_TASK_TAGS,
  type HarnessTaskTag,
} from "../src/task-classification.ts";

/** Every set of tags a task can carry, the empty set among them. */
const TAG_SETS: ReadonlySet<HarnessTaskTag>[] = Array.from(
  { length: 2 ** HARNESS_TASK_TAGS.length },
  (_, mask) => new Set(HARNESS_TASK_TAGS.filter((_, i) => mask & (1 << i))),
);

/** Every classified run: each tag set at each depth. */
const CLASSIFIED: RunShape[] = TAG_SETS.flatMap((tags) =>
  HARNESS_RUN_DEPTHS.map((depth) => ({ tags, depth }))
);

describe("prompt sections", () => {
  it("sends a task that was never classified every section but the stand-ins for piece targeting", () => {
    expect(
      PROMPT_SECTIONS.filter((section) =>
        sendsSection(section, { depth: "standard" })
      ),
    ).toEqual(
      PROMPT_SECTIONS.filter((section) =>
        section !== "held-pieces" && section !== "may-hold-pieces"
      ),
    );
  });

  it("sends every classified run exactly one stand-in for piece targeting", () => {
    for (const shape of CLASSIFIED) {
      expect([
        sendsSection("held-pieces", shape),
        sendsSection("may-hold-pieces", shape),
      ].filter(Boolean)).toHaveLength(1);
    }
  });

  it("never sends resolving a named piece twice: an author task reads it inside piece targeting", () => {
    for (const shape of CLASSIFIED) {
      expect(
        sendsSection("resolve-piece-tools", shape) &&
          sendsSection("piece-targeting", shape),
      ).toBe(false);
    }
  });

  it("gives a deep run of any kind the opening research pass, and at another depth only an author task", () => {
    for (const shape of CLASSIFIED) {
      expect(sendsSection("opening-research", shape)).toBe(
        shape.depth === "deep" || shape.tags?.has("author") === true,
      );
    }
  });
});
