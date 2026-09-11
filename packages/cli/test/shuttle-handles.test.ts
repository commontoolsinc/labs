/**
 * Unit tests for what a `%n` operand names — the row a listing numbered, and
 * the place that listing was read at — and for the line a run records, which
 * is that reading written back out.
 *
 * The lookup's claims divide in two. One is about the spelling — which tokens
 * are a handle at all — and it is closed by the digits: a listing prints `%3`
 * and nothing else, so every other spelling names no row. The other is about
 * the lookup itself, and what it turns on is that the row and the place come
 * back together, since a row's name is a name inside a place and neither alone
 * names a cell.
 *
 * The recording's claims divide the same way. Either a token bound to a row,
 * and the case says what the row is written as; or it bound to nothing, and
 * the case says the token comes back the characters it was typed with. The
 * second half is the larger one, since every token a line holds that is no
 * operand belongs to it.
 *
 * Nothing here reads or walks, so every case drives the whole of it with no
 * connection and no fabric.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import type { MemorySpace } from "@commonfabric/memory/interface";

import { recordedForm, resolveHandle } from "../lib/shuttle/handles.ts";
import type { ListingHandles, ListingRow } from "../lib/shuttle/listing.ts";
import { type Place, placeAtSpaceRoot } from "../lib/shuttle/place.ts";

const SPACE = "did:key:z6MkConnectedSpace" as MemorySpace;

/** The piece a listing inside one was read at. */
const PIECE = "of:fid1:abcdefghijklmnop";

/** Helper for the cases below, which is the place a listing was read at. */
const AT = placeAtSpaceRoot(SPACE);

/** Helper for the cases below, which is a place standing inside a piece. */
const IN_PIECE: Place = {
  position: { kind: "piece", space: SPACE, piece: PIECE, path: ["items"] },
  scope: "space",
};

/** Helper for the cases below, which is a listing numbering `rows`. */
function listed(...rows: ListingRow[]): ListingHandles {
  return { place: AT, rows };
}

/** Helper for the cases below, which is one row called `name`. */
function row(name: string, kind: ListingRow["kind"] = "value"): ListingRow {
  return { name, kind, operand: name };
}

/**
 * Helper for the cases below, which is the row a reading found, and the reason
 * where it found none.
 */
function found(reading: ReturnType<typeof resolveHandle>): unknown {
  return reading.kind === "row" ? reading.row.name : reading.reason;
}

describe("handles", () => {
  describe("resolveHandle()", () => {
    it("returns the row the number names, counting from one", () => {
      const reading = resolveHandle(listed(row("a"), row("b")), "%2");
      expect(found(reading)).toBe("b");
    });

    it("returns the place the listing was read at, beside the row", () => {
      // The pair is what makes a handle a bound reference rather than a row
      // number: a row's name is a name inside that place, so a reading
      // carrying one and not the other names nothing.

      const reading = resolveHandle(listed(row("a")), "%1");
      expect(reading.kind === "row" ? reading.at : undefined).toEqual(AT);
    });

    it("returns a row the listing offered no operand for, rather than refusing", () => {
      // Whether a row is somewhere to stand is the asking verb's question. A
      // callable is a row `cd` has nothing to walk to and `call` invokes, so
      // the lookup hands it over and says nothing about it.

      const reading = resolveHandle(
        listed({ name: "search", kind: "callable" }),
        "%1",
      );
      expect(reading.kind === "row" ? reading.row.kind : undefined)
        .toBe("callable");
    });

    it("refuses a token whose digits name no number a listing prints", () => {
      expect(found(resolveHandle(listed(row("a")), "%3x"))).toBe(
        "`%3x` names no handle. A handle is `%` and the number a listing " +
          "printed beside a row, as in `%3`.",
      );
    });

    it("refuses a leading-zero spelling, which is no number a listing printed", () => {
      // `%03` and `%3` would name one row, and a listing prints one of them.
      // Reading both would make the printed handle one spelling of several
      // rather than the thing a person read off the screen.

      expect(found(resolveHandle(listed(row("a"), row("b"), row("c")), "%03")))
        .toBe(
          "`%03` names no handle. A handle is `%` and the number a listing " +
            "printed beside a row, as in `%3`.",
        );
    });

    it("refuses the sigil on its own", () => {
      expect(found(resolveHandle(listed(row("a")), "%"))).toBe(
        "`%` names no handle. A handle is `%` and the number a listing " +
          "printed beside a row, as in `%3`.",
      );
    });

    it("refuses a token that does not open with the sigil at all", () => {
      // The operand grammar never hands one over — it reads the sigil at the
      // head of an operand and nowhere else — but this is a door of its own,
      // and a bare number reaching it would otherwise be read as the row of
      // that name with its first digit taken for the sigil.

      expect(found(resolveHandle(listed(row("a"), row("b"), row("c")), "33")))
        .toBe(
          "`33` names no handle. A handle is `%` and the number a listing " +
            "printed beside a row, as in `%3`.",
        );
    });

    it("refuses a number where no listing has numbered a row", () => {
      expect(found(resolveHandle(undefined, "%1"))).toBe(
        "`%1` names no row: no listing has numbered one yet. `ls` lists what " +
          "stands here and numbers what it lists.",
      );
    });

    it("refuses a number past the last row, naming the range there is", () => {
      expect(found(resolveHandle(listed(row("a"), row("b")), "%3"))).toBe(
        "`%3` names no row: the listing numbered `%1` to `%2`.",
      );
    });

    it("refuses a number where the listing numbered nothing, saying so", () => {
      // A range is what a person checks their number against, and `%1` to
      // `%0` is no range. An empty listing is told apart from a number past
      // the end because the two are different mistakes.

      expect(found(resolveHandle(listed(), "%1"))).toBe(
        "`%1` names no row: the listing numbered none.",
      );
    });
  });

  describe("recordedForm()", () => {
    it("returns the line with a handle written out as the row's own operand", () => {
      expect(recordedForm("cd %1", listed(row("thermo"), row("tracker"))))
        .toBe("cd thermo");
    });

    it("returns a spelling a later listing's numbering does not move", () => {
      // The claim the recording exists for. A handle is a reference until the
      // next listing, and a recalled line outlives listings, so the recorded
      // line has to name the row rather than the number: `%1` names the other
      // row once the second listing has run, and the line recorded against the
      // first goes on naming what it acted on.

      expect(recordedForm("set %1/target 25", listed(row("thermo"), row("t"))))
        .toBe("set thermo/target 25");
      const renumbered = listed(row("tracker"), row("thermo"));
      expect(found(resolveHandle(renumbered, "%1"))).toBe("tracker");
    });

    it("returns a line carrying no handle as the string it was given", () => {
      // Byte for byte, so the runs of whitespace and the quoting are the ones
      // that were typed. A recording that split the line and printed its
      // tokens back would pass a comparison of the words and fail this.

      expect(recordedForm("ls   'first name'  ", listed(row("a")))).toBe(
        "ls   'first name'  ",
      );
    });

    it("returns the text around a handle untouched, the separators included", () => {
      expect(recordedForm("cd   %1  ", listed(row("thermo"))))
        .toBe("cd   thermo  ");
    });

    it("returns every handle on the line written out, not the first alone", () => {
      expect(recordedForm("link %1 %2", listed(row("a"), row("b"))))
        .toBe("link a b");
    });

    it("returns a later handle written out though an earlier named no row", () => {
      // A token that bound to nothing stops nothing: the walk over the line
      // carries on to the tokens after it, which bound to what they bound to.

      expect(recordedForm("link %3 %1", listed(row("a"), row("b"))))
        .toBe("link %3 a");
    });

    it("returns the walk written after a handle as a further segment", () => {
      expect(recordedForm("set %1/target 25", listed(row("thermo"))))
        .toBe("set thermo/target 25");
    });

    it("returns a handle written with a trailing separator as the row alone", () => {
      // `%1/` names the row and nothing inside it, the walk after the handle
      // being empty, so the operand written for it carries no separator
      // either — one written there would name a segment with no name.

      expect(recordedForm("get %1/", listed(row("thermo")))).toBe("get thermo");
    });

    it("returns a row whose operand needs quoting as a quoted token", () => {
      expect(recordedForm("cd %1", listed(row("first name"))))
        .toBe("cd 'first name'");
    });

    it("returns a handle the line quoted written out as the row", () => {
      // The reading is over the token's value rather than over the characters
      // the line holds, which is the same value the operand grammar reads.

      expect(recordedForm("cd '%1'", listed(row("thermo")))).toBe("cd thermo");
    });

    it("returns a callable row as the receiver's reference and the verb name", () => {
      // Two tokens for one, and no single token would do: the handle carries a
      // receiver and a verb name, and a verb name is interface vocabulary
      // rather than a data path, so nothing an operand spells names one.

      const callable: ListingRow = { name: "add-reply", kind: "callable" };
      expect(recordedForm('call %1 \'{"text":"jam"}\'', {
        place: IN_PIECE,
        rows: [callable],
      })).toBe(
        "call /of:fid1:abcdefghijklmnop@space/items add-reply " +
          '\'{"text":"jam"}\'',
      );
    });

    it("returns a callable row as typed where a walk is written after it", () => {
      // A walk written after a handle ends at a cell, and a cell is a receiver
      // rather than a verb, so such a token carries no name for the two-token
      // spelling to be made of.

      expect(recordedForm("get %1/deeper", {
        place: IN_PIECE,
        rows: [{ name: "add-reply", kind: "callable" }],
      })).toBe("get %1/deeper");
    });

    it("returns a callable row as typed where the listing stood at no piece", () => {
      // The receiver is the place the listing was read at, and a place that is
      // no piece is no receiver. Nothing is written rather than a reference
      // made up for it.

      expect(recordedForm("call %1", listed({ name: "x", kind: "callable" })))
        .toBe("call %1");
    });

    it("returns a row the listing offered no operand for as typed", () => {
      // Neither the name nor the reference reaches such a row, so there is no
      // spelling to write in the handle's place.

      expect(recordedForm("cd %1", listed({ name: "-x", kind: "value" })))
        .toBe("cd %1");
    });

    it("returns a handle that named no row as typed, so it names none again", () => {
      expect(recordedForm("set %3 5", listed(row("a"), row("b"))))
        .toBe("set %3 5");
    });

    it("returns a handle written before any listing as typed", () => {
      expect(recordedForm("cd %1", undefined)).toBe("cd %1");
    });

    it("returns `%0` as typed, no listing having numbered one", () => {
      expect(recordedForm("cd %0", listed(row("a")))).toBe("cd %0");
    });

    it("returns a handle standing in an option's value as typed", () => {
      // What a token after an option is for is the verb's table to say, and a
      // `%1` written there is a character of that value rather than a handle:
      // the line sent it nowhere near the handle table, so a recording that
      // wrote a row out there would replay a line that acts differently.

      expect(recordedForm("ls --limit %1", listed(row("1"), row("2"))))
        .toBe("ls --limit %1");
    });

    it("returns a handle inside a callable's own section as typed", () => {
      // The section's tokens are the callable's input, and the call sent the
      // characters `%2`. A replay sending anything else would send the verb an
      // argument the first call never sent it.

      expect(recordedForm("call %1 --text %2", listed(row("a"), row("b"))))
        .toBe("call a --text %2");
    });

    it("returns a handle standing where the verb goes as typed", () => {
      expect(recordedForm("%1", listed(row("a")))).toBe("%1");
    });

    it("returns a line the split refuses as the string it was given", () => {
      expect(recordedForm("cd 'a %1", listed(row("a")))).toBe("cd 'a %1");
    });
  });
});
