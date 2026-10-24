import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { compareDumps, describeFailures } from "./check-cause-assignments.ts";
import {
  assignmentDigest,
  type PatternAssignment,
} from "./cause-assignments-lib.ts";
import type { AcceptedMove } from "./cause-assignments-accepted-moves.ts";

const CHILD = "cell, computed, written by sub-pattern child#Child";
const LIFT = "cell, computed, written by function";

/** One pattern's build, of one source, holding `cells` in number order. */
const build = (
  pattern: string,
  source: string,
  cells: readonly string[],
): PatternAssignment => ({
  pattern,
  source,
  levels: [{
    key: "",
    cells: cells.map((description, number) => ({
      number,
      description,
      holdsState: description === CHILD,
    })),
  }],
});

const dump = (...assignments: PatternAssignment[]) => ({
  assignments,
  errors: [],
});

const NUMBERED = build("room.tsx", "s", [LIFT, CHILD]);
const RENUMBERED = build("room.tsx", "s", [CHILD]);

describe("check-cause-assignments", () => {
  describe("compareDumps()", () => {
    it("returns a failure for a pattern whose child moves under the same source", async () => {
      const comparison = await compareDumps(
        dump(NUMBERED),
        dump(RENUMBERED),
        [],
      );

      expect(comparison.compared).toBe(1);
      expect(
        comparison.failing.map(({ pattern, moved }) => ({
          pattern,
          moved: moved.map((
            { from, to, holdsState },
          ) => [from, to, holdsState]),
        })),
      ).toEqual([{ pattern: "room.tsx", moved: [[1, 0, true]] }]);
    });

    it("returns no failure for a pattern numbered alike on both sides", async () => {
      const comparison = await compareDumps(
        dump(NUMBERED),
        dump(build("room.tsx", "s", [LIFT, CHILD])),
        [],
      );

      expect(comparison).toEqual({
        failing: [],
        forgiven: [],
        unused: [],
        compared: 1,
      });
    });

    it("returns no comparison of a pattern whose source differs between the two sides", async () => {
      const comparison = await compareDumps(
        dump(NUMBERED),
        dump(build("room.tsx", "edited", [CHILD])),
        [],
      );

      expect(comparison.compared).toBe(0);
      expect(comparison.failing).toEqual([]);
    });

    it("returns as forgiven a move an accepted entry names by both builds' digests", async () => {
      const entry: AcceptedMove = {
        pattern: "room.tsx",
        base: await assignmentDigest(NUMBERED),
        head: await assignmentDigest(RENUMBERED),
        reason: "test",
      };

      const comparison = await compareDumps(
        dump(NUMBERED),
        dump(RENUMBERED),
        [entry],
      );

      expect(comparison.failing).toEqual([]);
      expect(comparison.forgiven).toEqual(["room.tsx"]);
      expect(comparison.unused).toEqual([]);
    });

    it("returns as a failure a move an accepted entry names by another build, and the entry as unused", async () => {
      const entry: AcceptedMove = {
        pattern: "room.tsx",
        base: await assignmentDigest(NUMBERED),
        head: await assignmentDigest(build("room.tsx", "s", [CHILD, LIFT])),
        reason: "test",
      };

      const comparison = await compareDumps(
        dump(NUMBERED),
        dump(RENUMBERED),
        [entry],
      );

      expect(comparison.failing.map(({ pattern }) => pattern)).toEqual([
        "room.tsx",
      ]);
      expect(comparison.unused).toEqual([entry]);
    });
  });

  describe("describeFailures()", () => {
    it("returns each moved cell with its two numbers, whether it holds state, and both builds' digests", async () => {
      const comparison = await compareDumps(
        dump(NUMBERED),
        dump(RENUMBERED),
        [],
      );
      const text = describeFailures(comparison);

      expect(text).toContain(
        `room.tsx (base build ${await assignmentDigest(
          NUMBERED,
        )}, this build ${await assignmentDigest(RENUMBERED)}):`,
      );
      expect(text).toContain(`  1 -> 0, holds state: ${CHILD} (entry pattern)`);
    });
  });
});
