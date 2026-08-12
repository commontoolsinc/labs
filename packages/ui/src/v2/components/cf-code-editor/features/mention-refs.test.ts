import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { EditorState } from "@codemirror/state";
import {
  mentionRefEditFilter,
  mentionRefField,
  type MentionRefInfo,
  mentionRefs,
  parseMentionRefs,
  scanRefKeys,
  setKnownRefKeys,
} from "./mention-refs.ts";

const KEY = "a3f9zz";
const OTHER_KEY = "b7k2m1";

/** A headless state whose map holds `keys`. */
function createState(doc: string, keys: string[] = [KEY]): EditorState {
  const state = EditorState.create({
    doc,
    extensions: [mentionRefField, mentionRefEditFilter],
  });
  return state.update({ effects: setKnownRefKeys.of(keys) }).state;
}

describe("mention-refs", () => {
  describe("parseMentionRefs()", () => {
    const known = new Set([KEY]);

    it("returns an empty array for an empty string", () => {
      expect(parseMentionRefs("", known)).toEqual([]);
    });

    it("returns an empty array when no key is known", () => {
      expect(parseMentionRefs(`See [Note][${KEY}].`, new Set())).toEqual([]);
    });

    it("parses a token whose key the map holds", () => {
      const refs = parseMentionRefs(`See [My Note][${KEY}] for more`, known);
      expect(refs).toHaveLength(1);

      const ref = refs[0];
      expect(ref.label).toBe("My Note");
      expect(ref.key).toBe(KEY);
      expect(ref.from).toBe(4);
      expect(ref.labelFrom).toBe(5);
      expect(ref.labelTo).toBe(12);
      expect(ref.to).toBe(21);
    });

    it("returns positions that slice back to the original token", () => {
      const doc = `x [My Note][${KEY}] y`;
      const ref = parseMentionRefs(doc, known)[0];
      expect(doc.slice(ref.from, ref.to)).toBe(`[My Note][${KEY}]`);
      expect(doc.slice(ref.labelFrom, ref.labelTo)).toBe("My Note");
    });

    it("returns nothing for a token whose key the map does not hold", () => {
      expect(parseMentionRefs("See [the docs][readme] here", known)).toEqual(
        [],
      );
    });

    it("returns nothing for a reference link with an over-long key", () => {
      const doc = "[label][averylongreferencename]";
      expect(parseMentionRefs(doc, new Set(["averylongreferencename"])))
        .toEqual([]);
    });

    it("parses several tokens in one string", () => {
      const doc = `[A][${KEY}] and [B][${OTHER_KEY}]`;
      const refs = parseMentionRefs(doc, new Set([KEY, OTHER_KEY]));
      expect(refs.map((ref: MentionRefInfo) => ref.label)).toEqual(["A", "B"]);
      expect(refs.map((ref: MentionRefInfo) => ref.key)).toEqual([
        KEY,
        OTHER_KEY,
      ]);
    });

    it("parses a token with an empty label", () => {
      const refs = parseMentionRefs(`[][${KEY}]`, known);
      expect(refs).toHaveLength(1);
      expect(refs[0].label).toBe("");
      expect(refs[0].labelFrom).toBe(refs[0].labelTo);
    });

    it("returns nothing for a label broken across lines", () => {
      expect(parseMentionRefs(`[My\nNote][${KEY}]`, known)).toEqual([]);
    });
  });

  describe("scanRefKeys()", () => {
    it("returns keys the map does not hold", () => {
      expect(scanRefKeys(`[A][${KEY}] [B][${OTHER_KEY}]`)).toEqual(
        new Set([KEY, OTHER_KEY]),
      );
    });

    it("returns an empty set for text with no reference links", () => {
      expect(scanRefKeys("plain prose")).toEqual(new Set());
    });
  });

  describe("mentionRefField", () => {
    it("holds no references until keys are announced", () => {
      const state = EditorState.create({
        doc: `[A][${KEY}]`,
        extensions: [mentionRefField],
      });
      expect(mentionRefs(state)).toEqual([]);
    });

    it("parses references once keys are announced", () => {
      expect(mentionRefs(createState(`[A][${KEY}]`))).toHaveLength(1);
    });

    it("drops a reference whose key leaves the map", () => {
      const state = createState(`[A][${KEY}]`);
      const narrowed = state.update({ effects: setKnownRefKeys.of([]) }).state;
      expect(mentionRefs(narrowed)).toEqual([]);
    });

    it("updates positions when text is inserted before a reference", () => {
      const state = createState(`x [A][${KEY}]`);
      expect(mentionRefs(state)[0].from).toBe(2);

      const moved = state.update({ changes: { from: 0, to: 0, insert: "yy" } });
      expect(mentionRefs(moved.state)[0].from).toBe(4);
    });

    it("detects a reference added by an edit", () => {
      const state = createState("Hello ", [KEY]);
      expect(mentionRefs(state)).toEqual([]);

      const typed = state.update({
        changes: { from: 6, to: 6, insert: `[New][${KEY}]` },
      });
      expect(mentionRefs(typed.state)).toHaveLength(1);
      expect(mentionRefs(typed.state)[0].label).toBe("New");
    });

    it("returns the same value for a selection-only transaction", () => {
      const state = createState(`[A][${KEY}]`);
      const before = state.field(mentionRefField);
      const after = state.update({ selection: { anchor: 2 } }).state.field(
        mentionRefField,
      );
      expect(after).toBe(before);
    });
  });

  describe("mentionRefEditFilter", () => {
    it("applies an edit outside every reference", () => {
      const state = createState(`Hello [A][${KEY}] end`);
      const edited = state.update({
        changes: { from: 0, to: 5, insert: "Hi" },
      });
      expect(edited.state.doc.toString()).toBe(`Hi [A][${KEY}] end`);
    });

    it("applies an edit inside the label", () => {
      const state = createState(`[Note][${KEY}]`);
      const edited = state.update({
        changes: { from: 3, to: 3, insert: "X" },
      });
      expect(edited.state.doc.toString()).toBe(`[NoXte][${KEY}]`);
    });

    it("drops an edit starting inside the key", () => {
      const state = createState(`[Note][${KEY}]`);
      const ref = mentionRefs(state)[0];
      const edited = state.update({
        changes: { from: ref.labelTo + 2, to: ref.labelTo + 3, insert: "X" },
      });
      expect(edited.state.doc.toString()).toBe(`[Note][${KEY}]`);
    });

    it("truncates an edit running from the label into the key", () => {
      const state = createState(`[Note][${KEY}]`);
      const ref = mentionRefs(state)[0];
      const edited = state.update({
        changes: { from: 4, to: ref.labelTo + 3, insert: "X" },
      });
      expect(edited.state.doc.toString()).toBe(`[NotX][${KEY}]`);
    });

    it("applies an edit deleting a whole reference", () => {
      const state = createState(`before [Note][${KEY}] after`);
      const ref = mentionRefs(state)[0];
      const edited = state.update({
        changes: { from: ref.from, to: ref.to, insert: "" },
      });
      expect(edited.state.doc.toString()).toBe("before  after");
      expect(mentionRefs(edited.state)).toEqual([]);
    });

    it("applies an edit inside a reference link the map does not hold", () => {
      const state = createState("[the docs][readme]");
      const edited = state.update({
        changes: { from: 12, to: 13, insert: "X" },
      });
      expect(edited.state.doc.toString()).toBe("[the docs][rXadme]");
    });

    it("keeps an outside change while dropping a key edit in the same transaction", () => {
      const state = createState(`prefix [A][${KEY}] suffix`);
      const ref = mentionRefs(state)[0];
      const edited = state.update({
        changes: [
          { from: 0, to: 6, insert: "pre" },
          { from: ref.labelTo + 2, to: ref.labelTo + 3, insert: "X" },
        ],
      });
      expect(edited.state.doc.toString()).toBe(`pre [A][${KEY}] suffix`);
    });
  });
});
