import { assertEquals } from "@std/assert";
import { parseDocument } from "./view-helpers.ts";
import {
  buildWrapPlan,
  fitWrapChrome,
  wrappedRowAt,
} from "../lib/view/wrap.ts";

Deno.test("wrap layout: retains room for source text and a marker", () => {
  assertEquals(fitWrapChrome(8, 4, 1), {
    gutterWidth: 4,
    guideWidth: 1,
  });
  assertEquals(fitWrapChrome(6, 4, 1), {
    gutterWidth: 0,
    guideWidth: 1,
  });
  assertEquals(fitWrapChrome(5, 4, 0), {
    gutterWidth: 0,
    guideWidth: 0,
  });
  assertEquals(fitWrapChrome(2, 0, 1), {
    gutterWidth: 0,
    guideWidth: 0,
  });
});

Deno.test("wrap plan: splits long lines and keeps empty lines", () => {
  const doc = parseDocument("abcdefgh\n\nij");
  const plan = buildWrapPlan(doc.lines, "pictures", 4);

  assertEquals(
    Array.from({ length: plan.rowCount }, (_, row) => wrappedRowAt(plan, row)),
    [
      { line: 0, offset: 0, lastOffset: 6 },
      { line: 0, offset: 3, lastOffset: 6 },
      { line: 0, offset: 6, lastOffset: 6 },
      { line: 1, offset: 0, lastOffset: 0 },
      { line: 2, offset: 0, lastOffset: 0 },
    ],
  );
  assertEquals(plan.rowWidth, 4);
  assertEquals(plan.rowStride, 3);
  assertEquals(plan.firstRow, [0, 3, 4]);
  assertEquals(plan.lastRow, [2, 3, 4]);
});

Deno.test("wrap plan: exact-width lines do not add an empty row", () => {
  const doc = parseDocument("abcd");
  const plan = buildWrapPlan(doc.lines, "pictures", 4);
  assertEquals(plan.rowCount, 1);
  assertEquals(wrappedRowAt(plan, 0), {
    line: 0,
    offset: 0,
    lastOffset: 0,
  });
});

Deno.test("wrap plan: a non-positive width behaves as one column", () => {
  const doc = parseDocument("ab");
  const plan = buildWrapPlan(doc.lines, "pictures", 0);
  assertEquals(plan.rowCount, 2);
  assertEquals(plan.rowWidth, 1);
  assertEquals(plan.rowStride, 1);
  assertEquals(wrappedRowAt(plan, 0), {
    line: 0,
    offset: 0,
    lastOffset: 1,
  });
  assertEquals(wrappedRowAt(plan, 1), {
    line: 0,
    offset: 1,
    lastOffset: 1,
  });
});

Deno.test("wrap plan: uses the active non-printable display mode", () => {
  const doc = parseDocument("a\x1b[31mb");
  assertEquals(buildWrapPlan(doc.lines, "pictures", 3).rowCount, 3);
  assertEquals(buildWrapPlan(doc.lines, "hidden", 3).rowCount, 1);
});

Deno.test("wrap plan: rejects rows outside its layout", () => {
  const plan = buildWrapPlan([], "pictures", 4);
  assertEquals(plan.rowCount, 0);
  assertEquals(wrappedRowAt(plan, -1), undefined);
  assertEquals(wrappedRowAt(plan, 0), undefined);
});
