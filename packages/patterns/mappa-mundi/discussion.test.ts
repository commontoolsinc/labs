import { assert, assertEquals, assertMatch } from "@std/assert";

import { BANDS, CLAIMS, LAYERS, TABS, TIERS, WHY3 } from "./content.ts";
import {
  ANCHOR_KEYS,
  ANCHOR_TAB,
  ANCHOR_TEXT,
  ANCHORS,
  type Comment,
  countCss,
  questionKey,
  threadRows,
  WHY_ESSAY,
  WHY_MAP,
} from "./discussion.ts";

// Anchors are now the records' own stable ids. These tests are what stands
// between an edited concern and a silently orphaned thread — the whole reason
// the ids exist.

const rows = BANDS.flatMap((b) => b.domains.flatMap((d) => d.rows));
const layerChips = LAYERS.flatMap((l) => l.chips);
const tierChips = TIERS.flatMap((t) => t.groups.flatMap((g) => g.chips));

/** Every record in the document that carries an id. */
const allRecords = () => [
  ...CLAIMS,
  ...WHY3,
  ...LAYERS,
  ...layerChips,
  ...TIERS,
  ...TIERS.flatMap((t) => t.groups),
  ...tierChips,
  ...BANDS,
  ...BANDS.flatMap((b) => b.domains),
  ...rows,
];

Deno.test("the document still holds what it says it holds", () => {
  assertEquals(rows.length, 115);
  assertEquals(rows.filter((r) => r.flag).length, 23);
  assertEquals(layerChips.length, 34);
  assertEquals(tierChips.length, 44);
  assertEquals(CLAIMS.length, 5);
  assertEquals(BANDS.flatMap((b) => b.domains).length, 21);
});

Deno.test("every record has a unique id", () => {
  const ids = allRecords().map((r) => r.id);
  assertEquals(ids.length, 247);
  assertEquals(new Set(ids).size, ids.length, "two records share an id");
});

Deno.test("ids are safe to interpolate into a CSS selector", () => {
  // countCss puts these straight into [data-a="..."], so the alphabet matters.
  for (const r of allRecords()) assertMatch(r.id, /^[a-z][a-z0-9]*$/);
  for (const key of ANCHOR_KEYS) assertMatch(key, /^[a-z][a-z0-9_]*$/);
});

Deno.test("a record's anchor is its id, not its text", () => {
  // This is the property that makes renaming safe.
  for (const r of rows) {
    assert(ANCHOR_KEYS.has(r.id), `no anchor for ${r.name}`);
  }
  for (const c of CLAIMS) assertEquals(ANCHOR_TAB[c.id], "claims");
  for (const w of WHY3) assertEquals(ANCHOR_TAB[w.id], "orient");
  for (const l of LAYERS) assertEquals(ANCHOR_TAB[l.id], "orient");
  for (const t of TIERS) assertEquals(ANCHOR_TAB[t.id], "reach");
  for (const c of layerChips) assertEquals(ANCHOR_TAB[c.id], "orient");
  for (const c of tierChips) assertEquals(ANCHOR_TAB[c.id], "reach");
  assertEquals(ANCHOR_TAB[WHY_ESSAY], "why");
  assertEquals(ANCHOR_TAB[WHY_MAP], "why");
});

Deno.test("only flagged rows carry an open-question anchor", () => {
  for (const r of rows) {
    assertEquals(
      ANCHOR_KEYS.has(questionKey(r.id)),
      Boolean(r.flag),
      `${r.name} has the wrong question-anchor state`,
    );
  }
});

Deno.test("a concern and its open question stay different threads", () => {
  for (const r of rows.filter((r) => r.flag)) {
    const q = questionKey(r.id);
    assert(q !== r.id, `${r.name} collapses onto one anchor`);
    assert(
      ANCHOR_TEXT[r.id] !== ANCHOR_TEXT[q],
      `${r.name} shows the same referent for both`,
    );
  }
});

Deno.test("every anchor carries referent text and names a real tab", () => {
  const ids = new Set(TABS.map((t) => t.id));
  for (const a of ANCHORS) {
    assert((a.text ?? "").trim() !== "", `anchor ${a.key} has nothing to show`);
    assert((a.label ?? "").trim() !== "", `anchor ${a.key} has no label`);
    assert(ids.has(a.tab), `${a.key} points at a tab that does not exist`);
  }
});

Deno.test("every content tab has something to comment on", () => {
  const tabs = new Set(ANCHORS.map((a) => a.tab));
  // Discussion lists threads rather than hosting them, so it owns no anchors.
  for (const id of TABS.map((t) => t.id).filter((id) => id !== "talk")) {
    assert(tabs.has(id), `nothing on the ${id} tab can be commented on`);
  }
  assert(!tabs.has("talk"), "the Discussion tab should not host anchors");
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
    new RegExp(`\\[data-a="${a}"\\] \\.ccount::after\\{content:"2"\\}`),
  );
  assertMatch(
    css,
    new RegExp(`\\[data-a="${b}"\\] \\.ccount::after\\{content:"1"\\}`),
  );
  assertEquals(css.split("\n").length, 2);
});

Deno.test("count CSS drops a comment whose record was deleted", () => {
  assertEquals(countCss([comment("r99999")]), "");
});

Deno.test("count CSS never interpolates document text into a selector", () => {
  const css = countCss(ANCHORS.map((a) => comment(a.key)));
  for (const rule of css.split("\n")) {
    assertMatch(
      rule,
      /^\.mm \[data-a="[a-z][a-z0-9_]*"\] \.ccount::after\{content:"\d+"\}$/,
    );
  }
  assertEquals(css.split("\n").length, ANCHORS.length);
});

Deno.test("thread rows join comments to where they hang off", () => {
  const a = ANCHORS[0];
  const [row] = threadRows([comment(a.key)]);
  assertEquals(row.label, a.label);
  assertEquals(row.tab, a.tab);
  assertEquals(row.anchor, a.key);
});

Deno.test("thread rows keep append order and survive a deleted record", () => {
  const keys = ANCHORS.slice(0, 3).map((a) => a.key);
  const gone = "r99999";
  const out = threadRows(keys.concat([gone]).map(comment));
  // Order is the array's own; the Discussion tab flips it with CSS, not here.
  assertEquals(out.map((r) => r.anchor), keys.concat([gone]));
  assertEquals(out[3].label, "a place that has since been reworded");
  assert(out[3].tab !== "", "an orphaned row still needs somewhere to go");
});
