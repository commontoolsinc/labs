import { assert, assertEquals, assertMatch } from "@std/assert";

import { BANDS, LAYERS, TIERS } from "./content.ts";
import {
  ANCHOR_INDEX,
  ANCHOR_TEXT,
  ANCHORS,
  type Comment,
  concernKey,
  countCss,
  layerChipKey,
  questionKey,
  tierChipKey,
} from "./discussion.ts";

// Anchors are derived from the document's own text, so these tests are what
// stands between a reworded concern and a silently orphaned thread.

const rows = BANDS.flatMap((b) =>
  b.domains.flatMap((d) => d.rows.map((r) => ({ b, d, r })))
);

Deno.test("every commentable place has exactly one anchor", () => {
  const layerChips = LAYERS.reduce((n, l) => n + l.chips.length, 0);
  const tierChips = TIERS.reduce(
    (n, t) => n + t.groups.reduce((m, g) => m + g.chips.length, 0),
    0,
  );
  const flagged = rows.filter(({ r }) => r.flag).length;
  assertEquals(rows.length, 115);
  assertEquals(flagged, 23);
  assertEquals(layerChips, 34);
  assertEquals(tierChips, 44);
  // concerns + their open questions + both chip families
  assertEquals(ANCHORS.length, 115 + 23 + 34 + 44);
});

Deno.test("anchor keys are unique", () => {
  const keys = ANCHORS.map((a) => a.key);
  assertEquals(new Set(keys).size, keys.length, "two places share an anchor");
});

Deno.test("every concern resolves, and only flagged rows have a question", () => {
  for (const { b, d, r } of rows) {
    const self = concernKey(b.title, d.title, r.name);
    assert(ANCHOR_INDEX[self] !== undefined, `no anchor for ${r.name}`);
    const q = questionKey(b.title, d.title, r.name);
    assertEquals(
      ANCHOR_INDEX[q] !== undefined,
      Boolean(r.flag),
      `${r.name} has the wrong question-anchor state`,
    );
  }
});

Deno.test("a concern and its open question are different threads", () => {
  const flagged = rows.filter(({ r }) => r.flag);
  for (const { b, d, r } of flagged) {
    const self = concernKey(b.title, d.title, r.name);
    const q = questionKey(b.title, d.title, r.name);
    assert(self !== q, `${r.name} collapses onto one anchor`);
    assert(
      ANCHOR_TEXT[self] !== ANCHOR_TEXT[q],
      `${r.name} shows the same referent for both`,
    );
  }
});

Deno.test("every chip resolves", () => {
  for (const l of LAYERS) {
    for (const c of l.chips) {
      assert(
        ANCHOR_INDEX[layerChipKey(l.tone, c.label)] !== undefined,
        `no anchor for layer chip ${c.label}`,
      );
    }
  }
  for (const t of TIERS) {
    for (const g of t.groups) {
      for (const c of g.chips) {
        assert(
          ANCHOR_INDEX[tierChipKey(t.tname, g.label, c.label)] !== undefined,
          `no anchor for tier chip ${c.label}`,
        );
      }
    }
  }
});

Deno.test("every anchor carries referent text for the panel", () => {
  for (const a of ANCHORS) {
    assert(
      (ANCHOR_TEXT[a.key] ?? "").trim() !== "",
      `anchor ${a.key} has nothing to show`,
    );
  }
});

const comment = (anchor: string): Comment => ({
  anchor,
  author: null,
  body: "x",
  stampedAt: 0,
});

Deno.test("count CSS tallies per anchor", () => {
  const a = ANCHORS[0].key;
  const b = ANCHORS[1].key;
  const css = countCss([comment(a), comment(a), comment(b)]);
  assertMatch(
    css,
    new RegExp(
      `\\[data-a="${ANCHOR_INDEX[a]}"\\] .ccount::after\\{content:"2"\\}`,
    ),
  );
  assertMatch(
    css,
    new RegExp(
      `\\[data-a="${ANCHOR_INDEX[b]}"\\] .ccount::after\\{content:"1"\\}`,
    ),
  );
  assertEquals(css.split("\n").length, 2);
});

Deno.test("count CSS ignores comments on anchors that no longer exist", () => {
  // A reworded concern orphans its thread; it must not emit a broken rule.
  assertEquals(countCss([comment("cn|gone|gone|gone")]), "");
});

Deno.test("count CSS never interpolates document text into a selector", () => {
  const css = countCss(ANCHORS.map((a) => comment(a.key)));
  // Only the numeric index and the count may vary.
  for (const rule of css.split("\n")) {
    assertMatch(
      rule,
      /^\.mm \[data-a="\d+"\] \.ccount::after\{content:"\d+"\}$/,
    );
  }
  assertEquals(css.split("\n").length, ANCHORS.length);
});
