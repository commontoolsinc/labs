import { assert, assertEquals, assertMatch } from "@std/assert";

import { BANDS } from "./content.ts";
import {
  FLAG,
  FLAG_COUNT,
  LAYER_ORDER,
  layerOrderCss,
  LEDGER,
  MODE_CLASS,
  ROW_COUNT,
} from "./ordering.ts";
import { STYLES } from "./styles.ts";

const rows = LEDGER.flatMap((b) => b.domains.flatMap((d) => d.rows));
const domains = LEDGER.flatMap((b) => b.domains);

// The ledger ships as static markup that CSS sorts and filters, so these tests
// guard the classes the CSS keys off — that is what actually decides what the
// reader sees.

Deno.test("the document's status key matches the rows it describes", () => {
  assertEquals(ROW_COUNT, 115);
  assertEquals(FLAG_COUNT, 23);
  assertEquals(rows.length, ROW_COUNT);
});

Deno.test("the ledger keeps the source's maturity order", () => {
  const source = BANDS.flatMap((b) => b.domains.flatMap((d) => d.rows)).map(
    (r) => r.name,
  );
  assertEquals(rows.map((r) => r.name), source);
});

Deno.test("every row carries exactly one known layer-sort class", () => {
  const keys = Object.keys(LAYER_ORDER);
  for (const r of rows) {
    const found = keys.filter((k) => r.cls.split(" ").includes("lr-" + k));
    assertEquals(found.length, 1, `${r.name} has layer classes ${r.cls}`);
  }
});

Deno.test("the shipped stylesheet orders every layer, and only known layers", () => {
  // STYLES must be a plain literal (SES rejects a computed top-level value), so
  // the rules are hand-written. Pin them against LAYER_ORDER here instead.
  for (const [layer, order] of Object.entries(LAYER_ORDER)) {
    assertMatch(
      STYLES,
      new RegExp(`\\.mm \\.by-layer \\.crow\\.lr-${layer}\\{order:${order}\\}`),
    );
  }
  const shipped = STYLES.match(
    /\.mm \.by-layer \.crow\.lr-[a-z]+\{order:\d+\}/g,
  );
  assertEquals(shipped?.length, Object.keys(LAYER_ORDER).length);
  assertEquals(shipped?.join("\n"), layerOrderCss());
});

Deno.test("layer order runs Pattern, Shell, Mixed, then Fabric", () => {
  // The class suffixes are the document's own layer vocabulary.
  assertEquals(LAYER_ORDER.edge, 0); // Pattern
  assertEquals(LAYER_ORDER.shell, 1);
  assertEquals(LAYER_ORDER.mix, 2); // Mixed
  assertEquals(LAYER_ORDER.core, 3); // Fabric
});

Deno.test("flagged marks land on exactly the rows with an open question", () => {
  const flagged = rows.filter((r) => r.cls.split(" ").includes("flagged"));
  assertEquals(flagged.length, FLAG_COUNT);
  assert(flagged.every((r) => r.flag !== ""), "a flagged row has no question");
  assert(flagged.every((r) => r.flagMark === FLAG), "a flagged row lost its ⚑");
  const unflagged = rows.filter((r) => !r.cls.split(" ").includes("flagged"));
  assert(unflagged.every((r) => r.flag === ""), "an unflagged row has a tip");
  assert(unflagged.every((r) => r.flagMark === ""), "an unflagged row shows ⚑");
});

Deno.test("a domain is marked flagged iff it still holds an open question", () => {
  for (const d of domains) {
    const hasFlag = d.rows.some((r) => r.cls.includes("flagged"));
    assertEquals(
      d.cls.includes("flagged"),
      hasFlag,
      `${d.title} is misclassified for the open-questions filter`,
    );
  }
});

Deno.test("filtering to open questions never empties a surviving container", () => {
  // What the .flags-only rules leave behind must not be an empty shell.
  const surviving = domains.filter((d) => d.cls.includes("flagged"));
  assert(
    surviving.every((d) => d.rows.some((r) => r.cls.includes("flagged"))),
    "a domain survives the filter with no flagged row",
  );
  for (const b of LEDGER.filter((b) => b.cls.includes("flagged"))) {
    assert(
      b.domains.some((d) => d.cls.includes("flagged")),
      `band ${b.title} survives the filter with no flagged domain`,
    );
  }
});

Deno.test("every domain's flag count agrees with its flagged rows", () => {
  for (const band of BANDS) {
    for (const dom of band.domains) {
      assertEquals(
        dom.rows.filter((r) => r.flag).length,
        dom.flags,
        `${dom.title} disagrees with its own flag count`,
      );
    }
  }
});

Deno.test("every sort mode maps to a class the stylesheet defines", () => {
  assertEquals(Object.keys(MODE_CLASS).sort(), ["layer", "maturity", "open"]);
  assertEquals(MODE_CLASS.maturity, ""); // the emitted order needs no class
  assertEquals(MODE_CLASS.layer, "by-layer");
  assertEquals(MODE_CLASS.open, "flags-only");
});
