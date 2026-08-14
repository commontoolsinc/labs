/**
 * Unit tests for getNextUnusedLabel / STANDARD_LABELS.
 * Plain Deno.test — NOT a pattern. These exercise the pure label-selection
 * logic that record.tsx and template-registry.ts share.
 */
import { assertEquals } from "@std/assert";
import { getNextUnusedLabel, STANDARD_LABELS } from "./standard-labels.ts";
import type { SubPieceEntry } from "./types.ts";

// Build a minimal entry. The label logic only reads `type` and `label`; `piece`
// is required by the type but never inspected here.
function entry(type: string, label?: string): SubPieceEntry {
  return { type, pinned: false, piece: null, ...(label ? { label } : {}) };
}

Deno.test("empty list yields the first standard label", () => {
  assertEquals(getNextUnusedLabel("email", []), "Personal");
  assertEquals(getNextUnusedLabel("phone", []), "Mobile");
  assertEquals(getNextUnusedLabel("address", []), "Home");
});

Deno.test("skips labels already taken by same-type entries", () => {
  const entries = [entry("email", "Personal")];
  assertEquals(getNextUnusedLabel("email", entries), "Work");
});

Deno.test("walks the whole list as more labels are taken", () => {
  const entries = [
    entry("email", "Personal"),
    entry("email", "Work"),
  ];
  assertEquals(getNextUnusedLabel("email", entries), "School");
});

Deno.test("returns undefined once every standard label is used", () => {
  const entries = STANDARD_LABELS.email.map((label) => entry("email", label));
  assertEquals(getNextUnusedLabel("email", entries), undefined);
});

Deno.test("a different type starts its own sequence", () => {
  // Two emails are present, but a phone is unaffected by them.
  const entries = [entry("email", "Personal"), entry("email", "Work")];
  assertEquals(getNextUnusedLabel("phone", entries), "Mobile");
});

Deno.test("entries of other types do not consume labels", () => {
  // A phone labelled "Work" must not make the email skip "Work".
  const entries = [entry("phone", "Work")];
  assertEquals(getNextUnusedLabel("email", entries), "Personal");
});

Deno.test("entries without a usable label are ignored", () => {
  const entries = [
    entry("email"), // no label field
    entry("email", ""), // empty-string label
  ];
  assertEquals(getNextUnusedLabel("email", entries), "Personal");
});

Deno.test("a used label out of order is still skipped", () => {
  // "Work" taken but "Personal" free: the first free label wins, in list order.
  const entries = [entry("email", "Work")];
  assertEquals(getNextUnusedLabel("email", entries), "Personal");
});

Deno.test("types without standard labels return undefined", () => {
  assertEquals(getNextUnusedLabel("notes", []), undefined);
  assertEquals(getNextUnusedLabel("birthday", []), undefined);
  assertEquals(getNextUnusedLabel("", []), undefined);
});
