/**
 * Unit tests for a watch: what it is called, what it writes when the cell it
 * watches settles, and what stops it.
 *
 * Nothing here subscribes to anything. A settle is a call and a cancel is a
 * function, so every case drives the whole of it with no connection and no
 * terminal — which is what the module is shaped for.
 *
 * The cases that matter are the ones where a settle is *not* a change: the
 * first one, which is the baseline, and one that landed on the value the cell
 * already held. A watch that reported either would write a line for a change
 * nobody made.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import type { MemorySpace } from "@commonfabric/memory/interface";

import type { PiecePlace } from "../lib/shuttle/place.ts";
import {
  ArmedWatch,
  changesBetween,
  eventLine,
  watchEntries,
} from "../lib/shuttle/watch.ts";

const SPACE = "did:key:z6MkConnectedSpace" as MemorySpace;
const HANDLE = "of:fid1:abcdefghijklmnop";

/** How wide the screen is where a case is not asking about the width. */
const WIDE = 200;

/** Helper for the cases below, which is a place on a cell inside the piece. */
function at(...path: string[]): PiecePlace {
  return {
    position: { kind: "piece", space: SPACE, piece: HANDLE, path },
    scope: "space",
  };
}

/** What driving a watch produced: the lines it wrote, and the cancels it made. */
interface Driven {
  /** The watch itself. */
  readonly watch: ArmedWatch;

  /** Every line it wrote, in order. */
  readonly lines: string[];

  /** How many times the subscription it holds has been cancelled. */
  cancels: () => number;
}

/**
 * Helper for the cases below, which is a watch on `place` with its
 * subscription already handed over, recording what it writes.
 */
function driving(
  place: PiecePlace = at("replies"),
  columns = WIDE,
  input = false,
): Driven {
  const lines: string[] = [];
  let cancelled = 0;
  const watch = new ArmedWatch(
    { place, input },
    (line) => lines.push(line),
    () => columns,
  );
  watch.holding(() => cancelled++);
  return { watch, lines, cancels: () => cancelled };
}

describe("watch", () => {
  describe("ArmedWatch", () => {
    describe("instance members", () => {
      describe("label", () => {
        it("returns the cell written the short way the prompt writes a place", () => {
          expect(driving(at("replies")).watch.label)
            .toBe(`${HANDLE}/replies @space`);
        });

        it("carries the suffix where the cell watched is the piece's arguments", () => {
          expect(driving(at("replies"), WIDE, true).watch.label)
            .toBe(`${HANDLE}/replies#argument @space`);
        });

        it("names a piece's two cells apart", () => {
          // What every surface that shows a watch rests on. The two are two
          // watches, so a name that named only the place would list them as
          // one line twice and open both their event lines the same way,
          // leaving a person nothing to tell them apart by.

          const place = at("replies");
          expect(driving(place, WIDE, false).watch.label)
            .not.toBe(driving(place, WIDE, true).watch.label);
        });
      });

      describe("key", () => {
        it("returns the complete reference of the cell it watches", () => {
          expect(driving(at("replies")).watch.key)
            .toBe(`/${HANDLE}@space/replies`);
        });

        it("holds a piece's two cells apart", () => {
          // The same reference under `#argument` is another cell, so a watch
          // on each is two watches rather than a second one on the first.

          const place = at("replies");
          const result = new ArmedWatch(
            { place, input: false },
            () => {},
            () => WIDE,
          );
          const input = new ArmedWatch(
            { place, input: true },
            () => {},
            () => WIDE,
          );
          expect(result.key === input.key).toBe(false);
        });
      });

      describe("settled()", () => {
        it("writes nothing for the first settle, which is the baseline", () => {
          // The sink fires once on registration with what the cell already
          // holds. A watch reporting that would announce a change every time
          // one was armed.

          const driven = driving();
          driven.watch.settled(14);
          expect(driven.lines).toEqual([]);
        });

        it("writes the transition a change made, at the path it landed on", () => {
          const driven = driving(at("topics", "3"));
          driven.watch.settled({ title: "verb contracts", replies: 14 });
          driven.watch.settled({ title: "verb contracts", replies: 15 });
          expect(driven.lines).toEqual([
            `watch ${HANDLE}/topics/3 @space: replies 14 → 15`,
          ]);
        });

        it("opens the line with the name that says which of the two cells moved", () => {
          const driven = driving(at("replies"), WIDE, true);
          driven.watch.settled(14);
          driven.watch.settled(15);
          expect(driven.lines).toEqual([
            `watch ${HANDLE}/replies#argument @space: 14 → 15`,
          ]);
        });

        it("writes the transition alone where the watched cell is the leaf", () => {
          const driven = driving();
          driven.watch.settled(14);
          driven.watch.settled(15);
          expect(driven.lines).toEqual([
            `watch ${HANDLE}/replies @space: 14 → 15`,
          ]);
        });

        it("writes nothing for a settle that landed on the value already held", () => {
          // A recomputation that produced what was there is a settle and not a
          // change, and a line reading `14 → 14` would say one was made.

          const driven = driving();
          driven.watch.settled({ replies: 14 });
          driven.watch.settled({ replies: 14 });
          expect(driven.lines).toEqual([]);
        });

        it("writes one line for a settle that changed several leaves", () => {
          // One line per settled change, whatever the change turns out to be:
          // the leaves moved in one commit, and two lines would read as two.
          // Each of them carries its transition, a screen this wide being no
          // reason to write less than what moved.

          const driven = driving(at("topics"));
          driven.watch.settled({ title: "a", replies: 1 });
          driven.watch.settled({ title: "b", replies: 2 });
          expect(driven.lines.length).toBe(1);
          expect(driven.lines[0]).toBe(
            `watch ${HANDLE}/topics @space: title "a" → "b"; replies 1 → 2`,
          );
        });

        it("writes nothing once it has been disarmed", () => {
          const driven = driving();
          driven.watch.settled(14);
          driven.watch.disarm();
          driven.watch.settled(15);
          expect(driven.lines).toEqual([]);
        });

        it("asks how wide the screen is for each line rather than once", () => {
          // A change arrives long after the line that armed the watch, so the
          // width the line is fitted to is the width the window has then.

          const asked: number[] = [];
          const lines: string[] = [];
          let columns = WIDE;
          const watch = new ArmedWatch(
            { place: at("replies"), input: false },
            (line) => lines.push(line),
            () => {
              asked.push(columns);
              return columns;
            },
          );
          watch.settled(1);
          watch.settled(2);
          columns = 4;
          watch.settled(3);
          expect(asked).toEqual([WIDE, 4]);
          expect(lines[1]).toBe(
            `watch ${HANDLE}/replies @space: <a number> → <a number>`,
          );
        });
      });

      describe("holding()", () => {
        it("cancels at once where the watch was disarmed while it was arming", () => {
          // Arming is a read, so the cancel exists only once that read has
          // come back. A line cancelled in between must not leave a
          // subscription nothing holds a cancel for.

          const watch = new ArmedWatch(
            { place: at("replies"), input: false },
            () => {},
            () => WIDE,
          );
          let cancelled = 0;
          watch.disarm();
          watch.holding(() => cancelled++);
          expect(cancelled).toBe(1);
        });
      });

      describe("disarm()", () => {
        it("cancels the subscription it was holding", () => {
          const driven = driving();
          driven.watch.disarm();
          expect(driven.cancels()).toBe(1);
        });

        it("cancels once however many times it is called", () => {
          const driven = driving();
          driven.watch.disarm();
          driven.watch.disarm();
          expect(driven.cancels()).toBe(1);
        });
      });

      describe("armed", () => {
        it("returns `true` before it is disarmed and `false` after", () => {
          const driven = driving();
          const before = driven.watch.armed;
          driven.watch.disarm();
          expect({ before, after: driven.watch.armed })
            .toEqual({ before: true, after: false });
        });
      });
    });
  });

  describe("changesBetween()", () => {
    it("returns nothing for two values that are the same", () => {
      expect(changesBetween({ a: [1, 2] }, { a: [1, 2] })).toEqual([]);
    });

    it("returns the leaf that moved, and no other", () => {
      expect(changesBetween({ a: 1, b: 2 }, { a: 1, b: 3 }))
        .toEqual([{ at: ["b"], from: 2, to: 3 }]);
    });

    it("returns a key one side holds as a change to or from nothing", () => {
      // A cell reads as `undefined` at a key it does not hold, so a key gained
      // and a key lost are transitions rather than absences of one.

      expect(changesBetween({ a: 1 }, { a: 1, b: 2 }))
        .toEqual([{ at: ["b"], from: undefined, to: 2 }]);
      expect(changesBetween({ a: 1, b: 2 }, { a: 1 }))
        .toEqual([{ at: ["b"], from: 2, to: undefined }]);
    });

    it("returns an array's change at the index it landed on", () => {
      expect(changesBetween(["a", "b"], ["a", "c"]))
        .toEqual([{ at: [1], from: "b", to: "c" }]);
    });

    it("returns a member appended to an array as a change at its index", () => {
      expect(changesBetween(["a"], ["a", "b"]))
        .toEqual([{ at: [1], from: undefined, to: "b" }]);
    });

    it("returns one change where a value became a container", () => {
      // The walk descends only where both sides are the same kind of
      // container, so a leaf that became an object is one change rather than
      // a change per key it gained.

      expect(changesBetween({ a: 1 }, { a: { b: 2, c: 3 } }))
        .toEqual([{ at: ["a"], from: 1, to: { b: 2, c: 3 } }]);
    });

    it("returns one change where an array became an object", () => {
      // An array and an object are not the same kind of container, so neither
      // walks into the other.

      expect(changesBetween([1], { 0: 1 }))
        .toEqual([{ at: [], from: [1], to: { 0: 1 } }]);
    });

    it("returns the deep leaf that moved, at the whole path to it", () => {
      expect(changesBetween({ a: { b: [1, 2] } }, { a: { b: [1, 3] } }))
        .toEqual([{ at: ["a", "b", 1], from: 2, to: 3 }]);
    });
  });

  describe("eventLine()", () => {
    it("writes a path holding the separator as one segment", () => {
      // Escaped as it is everywhere else shuttle writes a path, so a key
      // holding one is one segment here too.

      expect(eventLine("cell @space", [{ at: ["a/b"], from: 1, to: 2 }], WIDE))
        .toBe("watch cell @space: a~1b 1 → 2");
    });

    it("writes what a change moved to and from as JSON", () => {
      expect(
        eventLine("cell @space", [{ at: [], from: "a", to: ["b"] }], WIDE),
      ).toBe('watch cell @space: "a" → ["b"]');
    });

    it("stands in for a value the writer has no form for", () => {
      expect(
        eventLine("cell @space", [{ at: [], from: undefined, to: 1 }], WIDE),
      ).toBe("watch cell @space: <nothing> → 1");
    });

    it("names the cell itself among several changed paths", () => {
      // A change at the cell itself has no path to name, and a line listing it
      // beside two that have would leave a gap where a name should be.

      expect(eventLine("cell @space", [
        { at: [], from: 1, to: 2 },
        { at: ["a"], from: 1, to: 2 },
      ], WIDE)).toBe(
        "watch cell @space: <the cell itself> 1 → 2; a 1 → 2",
      );
    });

    it("counts the changes it did not write out", () => {
      // What bounds the line as the commit grows: the length follows the shape
      // of the data rather than how many leaves moved at once.

      expect(eventLine("cell @space", [
        { at: ["a"], from: 1, to: 2 },
        { at: ["b"], from: 1, to: 2 },
        { at: ["c"], from: 1, to: 2 },
        { at: ["d"], from: 1, to: 2 },
        { at: ["e"], from: 1, to: 2 },
      ], WIDE)).toBe(
        "watch cell @space: a 1 → 2; b 1 → 2; c 1 → 2; and 2 more",
      );
    });

    it("stands in for the values of several changes before it counts them", () => {
      // The rungs are tried in order, so a line too narrow for the values is
      // written with each stood in for rather than dropping to the count while
      // there is still room to say what moved where.

      const long = "x".repeat(80);
      expect(eventLine("cell @space", [
        { at: ["a"], from: "", to: long },
        { at: ["b"], from: "", to: long },
      ], 160)).toBe(
        "watch cell @space: a <a string of 0 characters> → " +
          "<a string of 80 characters>; b <a string of 0 characters> → " +
          "<a string of 80 characters>",
      );
    });

    it("stands in for the values where the whole line would not fit", () => {
      // A value the fabric holds is as large as the fabric lets it be, and a
      // line that wrote one out would fill the terminal with the record of a
      // change nobody was reading a value for.

      const long = "x".repeat(120);
      expect(eventLine("cell @space", [{ at: ["a"], from: "", to: long }], 60))
        .toBe(
          "watch cell @space: a <a string of 0 characters> → " +
            "<a string of 120 characters>",
        );
    });

    it("writes the values where the whole line fits", () => {
      // The fitting is a fallback and not a policy: the same change on a wide
      // enough screen is written out.

      const long = "x".repeat(120);
      expect(eventLine("cell @space", [{ at: ["a"], from: "", to: long }], 300))
        .toBe(`watch cell @space: a "" → "${long}"`);
    });

    it("counts the changes alone where naming them would not fit either", () => {
      // The last rung, and the one thing that stays short however many changed
      // or however long their paths are.

      expect(eventLine("cell @space", [
        { at: ["a".repeat(40)], from: 1, to: 2 },
        { at: ["b".repeat(40)], from: 1, to: 2 },
      ], 40)).toBe("watch cell @space: 2 changes");
    });

    it("names one change however narrow the line, a count of one saying less", () => {
      // What the count replaces is the list, and a list of one has nothing to
      // gain from being counted: a line reading `1 change` names neither where
      // it landed nor that it moved.

      expect(eventLine("cell @space", [
        { at: ["a".repeat(40)], from: 1, to: 2 },
      ], 10)).toBe(
        `watch cell @space: ${"a".repeat(40)} <a number> → <a number>`,
      );
    });
  });

  describe("watchEntries()", () => {
    it("returns the word for none where nothing is armed", () => {
      expect(watchEntries([]))
        .toEqual([{ label: "watches", value: "none" }]);
    });

    it("returns the cell each armed watch is armed on", () => {
      const first = driving(at("title")).watch;
      const second = driving(at("replies")).watch;
      expect(watchEntries([first, second])).toEqual([{
        label: "watches",
        value: `${HANDLE}/title @space, ${HANDLE}/replies @space`,
      }]);
    });

    it("tells a piece's two cells apart where both are watched", () => {
      // The record answers what this run is watching, and two entries a
      // person cannot tell apart is that question going unanswered.

      const place = at("title");
      const result = driving(place, WIDE, false).watch;
      const input = driving(place, WIDE, true).watch;
      expect(watchEntries([result, input])).toEqual([{
        label: "watches",
        value: `${HANDLE}/title @space, ${HANDLE}/title#argument @space`,
      }]);
    });
  });
});
