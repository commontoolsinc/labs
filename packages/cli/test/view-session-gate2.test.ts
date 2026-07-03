/**
 * Direct unit tests for `session.ts`'s defensive guards. Each method below has
 * a guard for a state its normal callers never produce (an out-of-range index,
 * a missing overlay/buffer/policy/file-gateway, an empty match set, a zero-delta
 * hunk adjustment). The public key-handling flow can't reach those states, so
 * the guards are exercised by invoking the private method directly with the
 * edge input and asserting the method declines gracefully.
 */
import { assertEquals } from "@std/assert";
import { parseDocument, SAMPLE } from "./view-helpers.ts";
import { Session } from "../lib/view/session.ts";
import type { Key } from "../lib/view/keys.ts";

function makeSession(): Session {
  return new Session(parseDocument(SAMPLE), {
    color: false,
    showLineNumbers: false,
  }, { width: 90, height: 24 });
}

/** The private surface these tests reach into. */
type SessionPrivates = {
  selectNode(idx: number): void;
  moveCardSelection(delta: number): void;
  revealMatch(): void;
  handleOverlayKey(key: Key): void;
  prepareContextEdit(): void;
  editStart(): number | null;
  ensureCursorVisible(): void;
  computeEditedFiles(): string[];
  refreshPicker(): void;
  pickerUp(): void;
  activatePicked(): void;
  openPickedFile(absPath: string): void;
  adjustHunkCounts(oldDelta: number, newDelta: number): void;
};

function callPrivate<K extends keyof SessionPrivates>(
  session: Session,
  name: K,
  ...args: Parameters<SessionPrivates[K]>
): ReturnType<SessionPrivates[K]> {
  const method: (
    ...args: Parameters<SessionPrivates[K]>
  ) => ReturnType<SessionPrivates[K]> = Reflect.get(session, name);
  return method.apply(session, args);
}

Deno.test("selectNode: an out-of-range index leaves the selection untouched", () => {
  const s = makeSession();
  callPrivate(s, "selectNode", -1);
  assertEquals(s.view().selected, null);
  callPrivate(s, "selectNode", s.doc.flatStructure.length + 5);
  assertEquals(s.view().selected, null);
});

Deno.test("moveCardSelection: a no-op when no info overlay is open", () => {
  const s = makeSession();
  callPrivate(s, "moveCardSelection", 1);
  assertEquals(s.view().overlay, null);
});

Deno.test("revealMatch: a no-op when there are no matches", () => {
  const s = makeSession();
  const top = s.top;
  callPrivate(s, "revealMatch");
  assertEquals(s.top, top);
});

Deno.test("handleOverlayKey: a no-op when no overlay is open", () => {
  const s = makeSession();
  callPrivate(s, "handleOverlayKey", { name: "down" });
  assertEquals(s.view().overlay, null);
});

Deno.test("prepareContextEdit: a no-op on a plain file (no diff policy)", () => {
  const s = makeSession();
  callPrivate(s, "prepareContextEdit");
  assertEquals(s.view().overlay, null);
});

Deno.test("editStart: column 0 when there is no diff policy", () => {
  const s = makeSession();
  assertEquals(callPrivate(s, "editStart"), 0);
});

Deno.test("ensureCursorVisible: a no-op when there is no edit buffer", () => {
  const s = makeSession();
  const top = s.top;
  callPrivate(s, "ensureCursorVisible");
  assertEquals(s.top, top);
});

Deno.test("computeEditedFiles: empty when there is no source or buffer", () => {
  const s = makeSession();
  assertEquals(callPrivate(s, "computeEditedFiles"), []);
});

Deno.test("the file-picker helpers are no-ops without a file gateway", () => {
  const s = makeSession();
  callPrivate(s, "refreshPicker");
  callPrivate(s, "pickerUp");
  callPrivate(s, "activatePicked");
  callPrivate(s, "openPickedFile", "/anywhere/main.ts");
  // The picker was never entered, so no overlay was opened.
  assertEquals(s.view().overlay, null);
});

Deno.test("adjustHunkCounts: a no-op with no diff policy", () => {
  const s = makeSession();
  const top = s.top;
  callPrivate(s, "adjustHunkCounts", 0, 0);
  assertEquals(s.top, top);
});
