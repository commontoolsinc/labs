import { assert, assertEquals } from "@std/assert";

import {
  CLAIMS,
  LAYERS,
  LEDGER_INTRO,
  REACH_INTRO,
  WHISPER,
  WHY,
  WHY3,
} from "./content.ts";
import { paragraphs, parseMarkup, toMarkup } from "./markup.ts";

// The prose in this document used to be Seg[] — arrays of span objects — and
// was converted to `**bold**` markup so it can be edited in a textarea. These
// tests guard that conversion: a parser that loses a bold span silently changes
// what the document says.

Deno.test("parseMarkup splits emphasis out of a run", () => {
  assertEquals(parseMarkup("Fabric **is** the core"), [
    { t: "Fabric " },
    { t: "is", b: true },
    { t: " the core" },
  ]);
});

Deno.test("a lone asterisk is literal text", () => {
  // `email_triage_*` appears in a tier chip; it must not start an emphasis run.
  assertEquals(parseMarkup("email_triage_* and friends"), [
    { t: "email_triage_* and friends" },
  ]);
});

Deno.test("an unclosed run degrades instead of throwing", () => {
  // Half-typed emphasis should look wrong, not blank the panel.
  assertEquals(parseMarkup("a **b"), [{ t: "a " }, { t: "b", b: true }]);
});

Deno.test("empty and undefined input yield nothing", () => {
  assertEquals(parseMarkup(""), []);
  assertEquals(parseMarkup(undefined as unknown as string), []);
});

Deno.test("markup round-trips through parse and back", () => {
  // Every prose field the document actually ships.
  const runs = [
    WHISPER,
    REACH_INTRO,
    LEDGER_INTRO,
    ...CLAIMS.flatMap((c) => [c.villain, c.benefit, c.mech]),
    ...WHY3.map((w) => w.body),
    ...LAYERS.map((l) => l.what),
  ];
  assertEquals(runs.length, 24);
  for (const src of runs) {
    assertEquals(
      toMarkup(parseMarkup(src)),
      src,
      `lost content in: ${src.slice(0, 60)}`,
    );
  }
});

Deno.test("shipped prose still carries emphasis", () => {
  // A conversion that dropped every bold span would round-trip perfectly and
  // still be wrong, so assert the emphasis survived at all.
  const bolded = [WHISPER, ...CLAIMS.map((c) => c.mech)]
    .flatMap(parseMarkup)
    .filter((s) => s.b);
  assert(bolded.length > 0, "no emphasis survived the migration");
});

Deno.test("the Why essay keeps its paragraphs", () => {
  assertEquals(paragraphs(WHY.body).length, 3);
  assert(paragraphs(WHY.body).every((p) => p.trim() !== ""));
});

Deno.test("paragraphs ignores stray blank lines", () => {
  assertEquals(paragraphs("one\n\n\n\ntwo"), ["one", "two"]);
  assertEquals(paragraphs(""), []);
});
