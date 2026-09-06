/**
 * Unit tests for how the verbs are written down: the line `help` lists one on,
 * and the page `<verb> --help` writes.
 *
 * Every case drives the layout over verbs of its own rather than over the ones
 * shuttle has, so what is under test is the form and not the wording of any
 * verb: a summary reworded moves nothing here, and a column that stopped
 * lining up moves everything. What the real verbs say is asked in
 * `shuttle-verbs.test.ts`, where the table that holds it is.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import {
  renderVerbList,
  renderVerbPage,
  type VerbHelp,
} from "../lib/shuttle/help.ts";

/**
 * The verbs every case below lays out. `help [<verb>]` is the longest usage of
 * the three, which is what the column is measured from, and no summary is a
 * substring of a usage, so a case reading one off a line reads it where it was
 * written.
 */
const VERBS: readonly VerbHelp[] = [
  { usage: "ls", summary: "Lists.", detail: "One." },
  { usage: "cd <ref>", summary: "Moves.", detail: "Two." },
  { usage: "help [<verb>]", summary: "Explains.", detail: "Three." },
];

/** The column {@link VERBS} puts a summary in: the longest usage, and a gap. */
const COLUMN = "help [<verb>]".length + 2;

describe("help", () => {
  describe("renderVerbList()", () => {
    const LINES = renderVerbList(VERBS).split("\n");
    const ROWS = LINES.slice(0, VERBS.length);

    it("returns one row per verb, in the order given", () => {
      expect(ROWS.map((row) => row.split("  ")[0]))
        .toEqual(["ls", "cd <ref>", "help [<verb>]"]);
    });

    it("returns every summary starting at the one column", () => {
      expect(ROWS.map((row) => row.slice(COLUMN)))
        .toEqual(["Lists.", "Moves.", "Explains."]);
    });

    it("returns a column measured from the longest usage, so a longer one moves every summary", () => {
      const wider = [...VERBS, {
        usage: "describe <ref>!",
        summary: "Describes.",
        detail: "Four.",
      }];
      expect(renderVerbList(wider).split("\n")[0])
        .toBe(`ls${" ".repeat("describe <ref>!".length)}Lists.`);
    });

    it("returns the line naming `<verb> --help` last", () => {
      expect(LINES.at(-1)).toBe("`<verb> --help` says more about one verb.");
    });

    it("returns a blank line between the rows and that last line", () => {
      expect(LINES.at(-2)).toBe("");
    });

    it("returns no trailing line break, which leaves the caller ending the last line", () => {
      expect(renderVerbList(VERBS).endsWith("\n")).toBe(false);
    });
  });

  describe("renderVerbPage()", () => {
    const LINES = renderVerbPage(VERBS[1]).split("\n");

    it("returns the usage on the first line, under `Usage:`", () => {
      expect(LINES[0]).toBe("Usage: cd <ref>");
    });

    it("returns the summary under the usage, a blank line between them", () => {
      expect(LINES.slice(1, 3)).toEqual(["", "Moves."]);
    });

    it("returns the detail under the summary, a blank line between them", () => {
      expect(LINES.slice(3, 5)).toEqual(["", "Two."]);
    });

    it("returns the options block last, naming the `--help` every verb takes", () => {
      expect(LINES.slice(5)).toEqual([
        "",
        "Options:",
        "  -h, --help   Write this page instead of running the verb.",
      ]);
    });

    it("returns no trailing line break, which leaves the caller ending the last line", () => {
      expect(renderVerbPage(VERBS[1]).endsWith("\n")).toBe(false);
    });
  });
});
