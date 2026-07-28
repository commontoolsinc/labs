import { assertEquals } from "@std/assert";
import { parseDocument } from "./view-helpers.ts";
import {
  buildWrapPlan,
  fitWrapChrome,
  wrappedRowAt,
  wrappedRowForPosition,
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
      {
        row: 0,
        line: 0,
        offset: 0,
        lastOffset: 6,
        sourceWidth: 3,
        continues: true,
        wrapMarker: true,
        suffixWidth: 0,
      },
      {
        row: 1,
        line: 0,
        offset: 3,
        lastOffset: 6,
        sourceWidth: 3,
        continues: true,
        wrapMarker: true,
        suffixWidth: 0,
      },
      {
        row: 2,
        line: 0,
        offset: 6,
        lastOffset: 6,
        sourceWidth: 4,
        continues: false,
        wrapMarker: false,
        suffixWidth: 0,
      },
      {
        row: 3,
        line: 1,
        offset: 0,
        lastOffset: 0,
        sourceWidth: 4,
        continues: false,
        wrapMarker: false,
        suffixWidth: 0,
      },
      {
        row: 4,
        line: 2,
        offset: 0,
        lastOffset: 0,
        sourceWidth: 4,
        continues: false,
        wrapMarker: false,
        suffixWidth: 0,
      },
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
    row: 0,
    line: 0,
    offset: 0,
    lastOffset: 0,
    sourceWidth: 4,
    continues: false,
    wrapMarker: false,
    suffixWidth: 0,
  });
});

Deno.test("wrap plan: a non-positive width behaves as one column", () => {
  const doc = parseDocument("ab");
  const plan = buildWrapPlan(doc.lines, "pictures", 0);
  assertEquals(plan.rowCount, 2);
  assertEquals(plan.rowWidth, 1);
  assertEquals(plan.rowStride, 1);
  assertEquals(wrappedRowAt(plan, 0), {
    row: 0,
    line: 0,
    offset: 0,
    lastOffset: 1,
    sourceWidth: 1,
    continues: true,
    wrapMarker: false,
    suffixWidth: 0,
  });
  assertEquals(wrappedRowAt(plan, 1), {
    row: 1,
    line: 0,
    offset: 1,
    lastOffset: 1,
    sourceWidth: 1,
    continues: false,
    wrapMarker: false,
    suffixWidth: 0,
  });
});

Deno.test("wrap plan: a triangle reserves only its annotated line", () => {
  const doc = parseDocument("abcdefghij\n1234567");
  const plan = buildWrapPlan(
    doc.lines,
    "pictures",
    7,
    new Map([[0, { firstWidth: 1, continuationWidth: 1 }]]),
  );

  assertEquals(plan.firstRow, [0, 2]);
  assertEquals(plan.lastRow, [1, 2]);
  assertEquals(wrappedRowAt(plan, 0), {
    row: 0,
    line: 0,
    offset: 0,
    lastOffset: 5,
    sourceWidth: 5,
    continues: true,
    wrapMarker: true,
    suffixWidth: 1,
  });
  assertEquals(wrappedRowAt(plan, 1), {
    row: 1,
    line: 0,
    offset: 5,
    lastOffset: 5,
    sourceWidth: 6,
    continues: false,
    wrapMarker: false,
    suffixWidth: 1,
  });
  assertEquals(wrappedRowAt(plan, 2)?.sourceWidth, 7);
});

Deno.test("wrap plan: the first continuation can hold a wider label", () => {
  const doc = parseDocument("abcdefghij");
  const plan = buildWrapPlan(
    doc.lines,
    "pictures",
    7,
    new Map([[
      0,
      {
        firstWidth: 1,
        firstContinuationWidth: 3,
        continuationWidth: 1,
      },
    ]]),
  );

  assertEquals(plan.rowCount, 3);
  assertEquals(
    Array.from({ length: 3 }, (_, row) => wrappedRowAt(plan, row)),
    [
      {
        row: 0,
        line: 0,
        offset: 0,
        lastOffset: 8,
        sourceWidth: 5,
        continues: true,
        wrapMarker: true,
        suffixWidth: 1,
      },
      {
        row: 1,
        line: 0,
        offset: 5,
        lastOffset: 8,
        sourceWidth: 3,
        continues: true,
        wrapMarker: true,
        suffixWidth: 3,
      },
      {
        row: 2,
        line: 0,
        offset: 8,
        lastOffset: 8,
        sourceWidth: 6,
        continues: false,
        wrapMarker: false,
        suffixWidth: 1,
      },
    ],
  );
  assertEquals(wrappedRowForPosition(plan, 0, 4)?.row, 0);
  assertEquals(wrappedRowForPosition(plan, 0, 5)?.row, 1);
  assertEquals(wrappedRowForPosition(plan, 0, 8)?.row, 2);
});

Deno.test("wrap plan: a metadata label connects through continuation rows", () => {
  const doc = parseDocument("abcdefghij");
  const plan = buildWrapPlan(
    doc.lines,
    "pictures",
    7,
    new Map([[0, { firstWidth: 3, continuationWidth: 1 }]]),
  );

  assertEquals(plan.rowCount, 3);
  assertEquals(
    Array.from({ length: 3 }, (_, row) => wrappedRowAt(plan, row)),
    [
      {
        row: 0,
        line: 0,
        offset: 0,
        lastOffset: 8,
        sourceWidth: 3,
        continues: true,
        wrapMarker: true,
        suffixWidth: 3,
      },
      {
        row: 1,
        line: 0,
        offset: 3,
        lastOffset: 8,
        sourceWidth: 5,
        continues: true,
        wrapMarker: true,
        suffixWidth: 1,
      },
      {
        row: 2,
        line: 0,
        offset: 8,
        lastOffset: 8,
        sourceWidth: 6,
        continues: false,
        wrapMarker: false,
        suffixWidth: 1,
      },
    ],
  );
  assertEquals(wrappedRowForPosition(plan, 0, 2)?.row, 0);
  assertEquals(wrappedRowForPosition(plan, 0, 3)?.row, 1);
  assertEquals(wrappedRowForPosition(plan, 0, 8)?.row, 2);
  assertEquals(wrappedRowForPosition(plan, 0, 100)?.row, 2);
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
