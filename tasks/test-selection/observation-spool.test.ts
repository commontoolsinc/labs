/** Verifies replay order, payload storage, and temporary-file cleanup. */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { spy, stub } from "@std/testing/mock";

import { ObservationSpool } from "./observation-spool.ts";
import type { Observation } from "./score.ts";

/** One execution with a distinct name and the given start time. */
function observation(name: string, startedAt: string): Observation {
  return {
    test: { k: "unit", s: "example", n: name },
    outcome: "pass",
    durationMs: 1,
    day: startedAt.slice(0, 10),
    startedAt,
    commit: name,
    source: "main",
    place: "main",
  };
}

describe("ObservationSpool", () => {
  describe("constructor()", () => {
    it("removes the temporary file when opening it fails", () => {
      const created = spy(Deno, "makeTempFileSync");
      const opened = stub(Deno, "openSync", () => {
        throw new Error("open failed");
      });
      try {
        expect(() => new ObservationSpool()).toThrow("open failed");
        const path = created.calls[0]!.returned!;
        expect(() => Deno.statSync(path)).toThrow(Deno.errors.NotFound);
      } finally {
        opened.restore();
        created.restore();
      }
    });
  });

  describe("instance members", () => {
    it("replays stored runs in time order on every iteration", () => {
      using spool = new ObservationSpool();
      const later = observation("later", "2026-08-21T01:00:00.100Z");
      const earlier = observation("earlier", "2026-08-20T01:00:00Z");
      const tied = observation("tied", earlier.startedAt);
      spool.add([later]);
      spool.add([earlier, tied]);
      const expected = [earlier, tied, { ...later }];
      later.outcome = "fail";
      later.day = "2026-08-19";
      expect([...spool]).toEqual(expected);
      expect([...spool]).toEqual(expected);
      expect(spool.count).toBe(3);
      expect(spool.newestDay).toBe("2026-08-21");
    });

    it("orders fractional timestamps by instant", () => {
      using spool = new ObservationSpool();
      const later = observation("later", "2026-08-20T01:00:00.100Z");
      const earlier = observation("earlier", "2026-08-20T01:00:00Z");
      spool.add([later]);
      spool.add([earlier]);
      expect([...spool]).toEqual([earlier, later]);
    });

    it("replays nothing when no run has observations", () => {
      using spool = new ObservationSpool();
      spool.add([]);
      expect([...spool]).toEqual([]);
      expect(spool.count).toBe(0);
      expect(spool.newestDay).toBeUndefined();
    });

    it("refuses a run with invalid or differing start times", () => {
      using spool = new ObservationSpool();
      expect(() => spool.add([observation("invalid", "not a date")]))
        .toThrow("one valid start time");
      expect(() =>
        spool.add([
          observation("earlier", "2026-08-20T01:00:00Z"),
          observation("later", "2026-08-20T02:00:00Z"),
        ])
      ).toThrow("one valid start time");
      expect(spool.count).toBe(0);
    });

    it("refuses a truncated payload and removes it on disposal", () => {
      const created = spy(Deno, "makeTempFileSync");
      try {
        {
          using spool = new ObservationSpool();
          spool.add([observation("stored", "2026-08-20T01:00:00Z")]);
          Deno.truncateSync(created.calls[0]!.returned!, 1);
          expect(() => [...spool]).toThrow("observation spool is truncated");
        }
        expect(() => Deno.statSync(created.calls[0]!.returned!))
          .toThrow(Deno.errors.NotFound);
      } finally {
        created.restore();
      }
    });
  });
});
