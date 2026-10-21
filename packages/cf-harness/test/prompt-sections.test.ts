import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { PROMPT_SECTIONS, sendsSection } from "../src/prompt-sections.ts";
import {
  HARNESS_TASK_TAGS,
  type HarnessTaskTag,
} from "../src/task-classification.ts";

/** Every set of tags a task can carry, the empty set among them. */
const TAG_SETS: ReadonlySet<HarnessTaskTag>[] = Array.from(
  { length: 2 ** HARNESS_TASK_TAGS.length },
  (_, mask) => new Set(HARNESS_TASK_TAGS.filter((_, i) => mask & (1 << i))),
);

const sent = (tags: ReadonlySet<HarnessTaskTag> | undefined) =>
  PROMPT_SECTIONS.filter((section) => sendsSection(section, tags));

describe("prompt sections", () => {
  it("sends a task that was never classified every section but the stand-ins for piece targeting", () => {
    expect(sent(undefined)).toEqual(
      PROMPT_SECTIONS.filter((section) =>
        section !== "held-pieces" && section !== "may-hold-pieces"
      ),
    );
  });

  it("sends every classified task exactly one stand-in for piece targeting", () => {
    for (const tags of TAG_SETS) {
      expect([
        sendsSection("held-pieces", tags),
        sendsSection("may-hold-pieces", tags),
      ].filter(Boolean)).toHaveLength(1);
    }
  });

  it("never sends resolving a named piece twice: an author task reads it inside piece targeting", () => {
    for (const tags of TAG_SETS) {
      expect(
        sendsSection("resolve-piece-tools", tags) &&
          sendsSection("piece-targeting", tags),
      ).toBe(false);
    }
  });
});
