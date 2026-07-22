import { assertEquals } from "@std/assert";
import { baselineFrom, compare, totalOf } from "./check-json-ok.ts";

// The live-tree half of this check is `deno task check-json-ok`, which the CI
// `check` job runs; it needs a full `deno lint` pass, so it is a task rather
// than a test. What is unit-tested here is the comparison that decides whether
// that pass agrees with the baseline.

Deno.test("compare finds nothing when the baseline is exact", () => {
  const { regressions, stale } = compare(
    { "a.ts": 2, "b.ts": 1 },
    new Map([["a.ts", 2], ["b.ts", 1]]),
  );
  assertEquals(regressions, []);
  assertEquals(stale, []);
});

Deno.test("compare reports a file over its budget as a regression", () => {
  const { regressions, stale } = compare(
    { "a.ts": 2 },
    new Map([["a.ts", 3]]),
  );
  assertEquals(regressions, [{ file: "a.ts", budget: 2, actual: 3 }]);
  assertEquals(stale, []);
});

Deno.test("compare reports a file under its budget as stale", () => {
  const { regressions, stale } = compare(
    { "a.ts": 2 },
    new Map([["a.ts", 1]]),
  );
  assertEquals(regressions, []);
  assertEquals(stale, [{ file: "a.ts", budget: 2, actual: 1 }]);
});

Deno.test("compare treats an unlisted file as a zero budget", () => {
  const { regressions } = compare({}, new Map([["new.ts", 1]]));
  assertEquals(regressions, [{ file: "new.ts", budget: 0, actual: 1 }]);
});

Deno.test("compare reports a fully-cleaned file as stale", () => {
  const { stale } = compare({ "a.ts": 3 }, new Map());
  assertEquals(stale, [{ file: "a.ts", budget: 3, actual: 0 }]);
});

Deno.test("compare reports both directions at once", () => {
  const { regressions, stale } = compare(
    { "a.ts": 1, "b.ts": 5 },
    new Map([["a.ts", 4], ["b.ts", 2]]),
  );
  assertEquals(regressions, [{ file: "a.ts", budget: 1, actual: 4 }]);
  assertEquals(stale, [{ file: "b.ts", budget: 5, actual: 2 }]);
});

Deno.test("compare orders its findings by path", () => {
  const { regressions } = compare(
    {},
    new Map([["c.ts", 1], ["a.ts", 1], ["b.ts", 1]]),
  );
  assertEquals(regressions.map((r) => r.file), ["a.ts", "b.ts", "c.ts"]);
});

Deno.test("baselineFrom drops files with no unjustified calls", () => {
  assertEquals(
    baselineFrom(new Map([["a.ts", 2], ["b.ts", 0]])),
    { "a.ts": 2 },
  );
});

Deno.test("totalOf sums the recorded debt", () => {
  assertEquals(totalOf({ "a.ts": 2, "b.ts": 3 }), 5);
  assertEquals(totalOf({}), 0);
});
