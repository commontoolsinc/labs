import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  confirmLiftImplementations,
  implementationMatches,
  liftRunningStates,
  locateLift,
  parseSrc,
  PREVIEW_LENGTH,
  type ResolvedTopicsLift,
  runThenStop,
  timingDelta,
  type TopicsLiftSite,
  WORKER_RUN_TIMING_KEY,
  workerRunCount,
} from "../integration/topics-browser-measurement-core.ts";

describe("topics-browser-measurement-core", () => {
  const fryer = [
    'import { lift } from "commonfabric";',
    "",
    "const doubled = lift(",
    "  (value: number) => value * 2,",
    ");",
    "",
    "/** Counts the glazed donuts. */",
    "const glazeCount = lift(({ donuts }: { donuts: Donut[] }) =>",
    "  donuts.filter((donut) => donut.glazed).length",
    ");",
    "",
  ].join("\n");

  describe("locateLift()", () => {
    it("returns the line and column where the lift's function starts", () => {
      expect(locateLift(fryer, "doubled").position).toEqual({
        line: 4,
        col: 2,
      });
    });

    it("returns a later line for the same lift once lines are added above it", () => {
      expect(locateLift(`// one\n// two\n\n${fryer}`, "doubled").position)
        .toEqual({ line: 7, col: 2 });
    });

    it("returns the position after a comment between the call and the function", () => {
      const text = "const doubled = lift( /* note */ (value: number) => 2);";
      expect(locateLift(text, "doubled").position).toEqual({
        line: 1,
        col: 33,
      });
    });

    it("returns the declaration's text up to the next top-level statement", () => {
      expect(locateLift(fryer, "doubled").text).toBe(
        "(value: number) => value * 2,\n);\n\n",
      );
    });

    it("throws for a binding that is not declared as a lift", () => {
      expect(() =>
        locateLift("const doubled = computed(() => 2);", "doubled", "fryer.tsx")
      ).toThrow("`const doubled = lift(...)` declaration in fryer.tsx");
    });

    it("throws for a lift declared twice", () => {
      expect(() => locateLift(`${fryer}\n${fryer}`, "doubled"))
        .toThrow("found 2");
    });
  });

  describe("parseSrc()", () => {
    it("returns the module identity and the site of a run's `src`", () => {
      expect(parseSrc("cf:module/fryer1/donuts/fryer.tsx:12:20")).toEqual({
        identity: "fryer1",
        site: "/donuts/fryer.tsx:12:20",
      });
    });

    it("returns `undefined` for a `src` of another form", () => {
      expect(parseSrc("file:///donuts/fryer.tsx:12:20")).toBeUndefined();
    });
  });

  describe("liftRunningStates()", () => {
    const lifts: TopicsLiftSite[] = [{
      name: "glazeCount",
      module: "donuts/fryer.tsx",
      role: "consumer",
      site: "/donuts/fryer.tsx:12:20",
    }];
    const src = (path: string, identity = "fryer1") =>
      `cf:module/${identity}${path}`;

    it("returns `true` for a lift whose module runs an action at its site", () => {
      expect(
        liftRunningStates(lifts, [
          src("/donuts/fryer.tsx:12:20"),
          src("/donuts/fryer.tsx:40:2"),
        ]),
      ).toEqual(new Map([["/donuts/fryer.tsx:12:20", true]]));
    });

    it("returns `true` for a running lift beside another module with the same file name", () => {
      expect(
        liftRunningStates(lifts, [
          src("/donuts/fryer.tsx:12:20"),
          src("/bagels/fryer.tsx:3:2", "bagels1"),
        ]),
      ).toEqual(new Map([["/donuts/fryer.tsx:12:20", true]]));
    });

    it("returns `false` for a lift whose module file no `src` names", () => {
      expect(
        liftRunningStates(lifts, [src("/donuts/glaze.tsx:3:2", "glaze1"), ""]),
      ).toEqual(new Map([["/donuts/fryer.tsx:12:20", false]]));
    });

    it("throws for a module that has not started while its file runs under another path", () => {
      expect(() =>
        liftRunningStates(lifts, [src("/bagels/fryer.tsx:12:20", "bagels1")])
      ).toThrow(
        "which has not started, but its file runs as `/bagels/fryer.tsx`",
      );
    });

    it("throws for a module deployed under another root than the one resolved", () => {
      const topics: TopicsLiftSite[] = [{
        name: "crossrefTable",
        module: "topics/main.tsx",
        role: "producer",
        site: "/topics/main.tsx:337:2",
      }];
      expect(() =>
        liftRunningStates(topics, [
          src("/packages/patterns/topics/main.tsx:337:2", "board1"),
        ])
      ).toThrow("also runs as `/packages/patterns/topics/main.tsx`");
    });

    it("throws for a copy of the module under another root beside the resolved one", () => {
      expect(() =>
        liftRunningStates(lifts, [
          src("/donuts/fryer.tsx:12:20"),
          src("/bakery/donuts/fryer.tsx:12:20", "bakery1"),
        ])
      ).toThrow("also runs as `/bakery/donuts/fryer.tsx`");
    });

    it("throws for a module file named by a `src` it cannot parse", () => {
      expect(() => liftRunningStates(lifts, ["file:///bagels/fryer.tsx:12:20"]))
        .toThrow("its file runs as `file:///bagels/fryer.tsx:12:20`");
    });

    it("throws for a running module with no action at the lift's site", () => {
      expect(() => liftRunningStates(lifts, [src("/donuts/fryer.tsx:19:20")]))
        .toThrow("has no action there");
    });

    it("throws for a module running as two versions", () => {
      expect(() =>
        liftRunningStates(lifts, [
          src("/donuts/fryer.tsx:12:20", "fryer1"),
          src("/donuts/fryer.tsx:12:20", "fryer2"),
        ])
      ).toThrow("runs as 2 module versions");
    });
  });

  describe("implementationMatches()", () => {
    const glazeCount = locateLift(fryer, "glazeCount").text;

    it("returns `true` for the emitted form of the declared function", () => {
      expect(
        implementationMatches(
          "({ donuts }) => donuts.filter((donut) => donut.glazed).length",
          glazeCount,
        ),
      ).toBe(true);
    });

    it("returns `true` for an emitted form calling an import through a module alias", () => {
      const declaration =
        "({ table, self }) =>\n  table.filter((row) => equals(self, row.topic))\n";
      expect(
        implementationMatches(
          "({ table, self }) => table\n    .filter((row) => (0, commonfabric_2.equals)(self, row.topic))",
          declaration,
        ),
      ).toBe(true);
    });

    it("returns `true` for a preview cut partway through its last identifier", () => {
      const declaration = `({ donuts }) => {\n  ${
        "const glazed = donuts;\n  ".repeat(12)
      }return glazedDonutCount;\n}`;
      const emitted = `({ donuts }) => {\n    ${
        "const glazed = donuts;\n    ".repeat(12)
      }return glazedDonutCount;\n}`;
      const preview = emitted.slice(0, PREVIEW_LENGTH);
      expect(preview.length).toBe(PREVIEW_LENGTH);
      expect(implementationMatches(preview, declaration)).toBe(true);
    });

    it("returns `false` for another lift's function", () => {
      expect(implementationMatches("(value) => value * 2", glazeCount)).toBe(
        false,
      );
    });
  });

  describe("confirmLiftImplementations()", () => {
    const glaze = locateLift(fryer, "glazeCount");
    const resolved: ResolvedTopicsLift[] = [{
      name: "glazeCount",
      module: "donuts/fryer.tsx",
      role: "consumer",
      site: `/donuts/fryer.tsx:${glaze.position.line}:${glaze.position.col}`,
      declaration: glaze.text,
    }];
    const site = resolved[0].site;
    const glazePreview =
      "({ donuts }) => donuts.filter((donut) => donut.glazed).length";

    it("returns the preview of the implementation running at a running lift's site", () => {
      expect(
        confirmLiftImplementations(
          resolved,
          [{ [`cf:module/fryer1${site}`]: [glazePreview] }],
          new Map([[site, true]]),
        ),
      ).toEqual(new Map([[site, glazePreview]]));
    });

    it("returns no entry for a lift that is not running", () => {
      expect(
        confirmLiftImplementations(resolved, [{}], new Map([[site, false]])),
      ).toEqual(new Map());
    });

    it("throws when the site holds another lift, as when the sources read have extra lines", () => {
      // The sources read put `glazeCount` two lines lower than the running
      // module does, where the running `doubled` happens to start at the same
      // column.

      const shifted = locateLift(`\n\n${fryer}`, "glazeCount");
      const collided: ResolvedTopicsLift[] = [{
        ...resolved[0],
        site: "/donuts/fryer.tsx:4:2",
        declaration: shifted.text,
      }];
      expect(() =>
        confirmLiftImplementations(
          collided,
          [{
            "cf:module/fryer1/donuts/fryer.tsx:4:2": ["(value) => value * 2"],
          }],
          new Map([["/donuts/fryer.tsx:4:2", true]]),
        )
      ).toThrow("but the action there runs `(value) => value * 2`");
    });

    it("throws when no snapshot shows an implementation at a running lift's site", () => {
      expect(() =>
        confirmLiftImplementations(resolved, [{}], new Map([[site, true]]))
      ).toThrow("no action in a graph snapshot there shows its implementation");
    });
  });

  describe("timingDelta()", () => {
    it("returns each key's samples since the first snapshot, joining all-digit segments and dropping excluded requests", () => {
      expect(
        timingDelta(
          {
            "vdom-renderer/batch/0": [1, 2],
            "runtime-client/ipc/cell:get": [3, 30],
          },
          {
            "vdom-renderer/batch/0": [1, 2],
            "vdom-renderer/batch/7": [1, 5],
            "vdom-renderer/batch/8": [1, 4],
            "runtime-client/ipc/cell:get": [5, 50],
            "runtime-client/ipc/runtime:getGraphSnapshot": [1, 9],
          },
          new Set(["runtime:getGraphSnapshot"]),
        ),
      ).toEqual([
        { key: "runtime-client/ipc/cell:get", count: 2, totalMs: 20 },
        { key: "vdom-renderer/batch/*", count: 2, totalMs: 9 },
      ]);
    });
  });

  describe("workerRunCount()", () => {
    it("returns the runs counted under the scheduler's run span, not its children", () => {
      // The worker's `scheduler` logger reports these three keys: the span
      // `runSchedulerAction` opens around a run, and the action and commit
      // spans inside it.

      const before = {
        "scheduler/scheduler/run": [40, 80],
        "scheduler/scheduler/run/action": [40, 50],
        "scheduler/scheduler/run/commit": [12, 9],
      } as const;
      const after = {
        "scheduler/scheduler/run": [47, 95],
        "scheduler/scheduler/run/action": [55, 64],
        "scheduler/scheduler/run/commit": [15, 11],
      } as const;
      expect(WORKER_RUN_TIMING_KEY).toBe("scheduler/scheduler/run");
      expect(workerRunCount(before, after)).toBe(7);
    });

    it("throws for timing without the scheduler's run span", () => {
      expect(() =>
        workerRunCount({}, { "scheduler/scheduler/run/action": [3, 1] })
      ).toThrow("no `scheduler/scheduler/run` key");
    });
  });

  describe("runThenStop()", () => {
    it("returns both results when neither step fails", async () => {
      expect(
        await runThenStop(() => Promise.resolve(1), () => Promise.resolve(2)),
      ).toEqual({ value: 1, stopped: 2 });
    });

    it("throws the operation's error after stopping when only the operation fails", async () => {
      const operation = new Error("fryer jammed");
      let stops = 0;
      await expect(runThenStop(() => Promise.reject(operation), () => {
        stops++;
        return Promise.resolve();
      })).rejects.toBe(operation);
      expect(stops).toBe(1);
    });

    it("throws the stop error when only stopping fails", async () => {
      const stop = new Error("oil still hot");
      await expect(
        runThenStop(() => Promise.resolve(1), () => Promise.reject(stop)),
      ).rejects.toBe(stop);
    });

    it("throws an `AggregateError` holding the operation's error, then the stop error, when both fail", async () => {
      const operation = new Error("fryer jammed");
      const stop = new Error("oil still hot");
      const thrown = await runThenStop(
        () => Promise.reject(operation),
        () => Promise.reject(stop),
      ).then(() => undefined, (error: unknown) => error);
      expect(thrown).toBeInstanceOf(AggregateError);
      expect((thrown as AggregateError).errors).toEqual([operation, stop]);
    });
  });
});
