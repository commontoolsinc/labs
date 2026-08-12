import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { checkShape, coversPath } from "./check-docs-history-index.ts";

const TITLE = "# Index of historical documents";
const PROSE = "One line per archived document; the rules are in `README.md`.";

const index = (...body: string[]): string =>
  [TITLE, "", PROSE, "", ...body].join("\n");

describe("checkShape", () => {
  it("accepts a title, one line of prose, headings, and one-line entries", () => {
    const { problems, entries } = checkShape(index(
      "## Audits and reports",
      "",
      "- [a.md](specs/a.md) — an audit, July 2026.",
      "",
      "## Executed plans and work orders",
      "",
      "- [b.md](plans/b.md) — a plan, August 2026.",
    ));
    expect(problems).toEqual([]);
    expect(entries.map((entry) => entry.targets)).toEqual([
      ["specs/a.md"],
      ["plans/b.md"],
    ]);
  });

  it("reads every target from an entry that groups several documents", () => {
    const { problems, entries } = checkShape(index(
      "## Investigations, journals, and working notes",
      "",
      "- [a.md](packages/a.md) and [b.md](packages/b.md) — working notes.",
    ));
    expect(problems).toEqual([]);
    expect(entries[0].targets).toEqual(["packages/a.md", "packages/b.md"]);
  });

  it("rejects a wrapped entry, which a union merge can splice", () => {
    // The failure this exists for: two branches each add an entry whose last
    // line is "  August 2026.", and the union merge keeps that line once.
    const { problems } = checkShape(index(
      "## Audits and reports",
      "",
      "- [a.md](specs/a.md) — an audit of the thing that was audited,",
      "  August 2026.",
    ));
    expect(problems.length).toBe(1);
    expect(problems[0].lineNumber).toBe(8);
    expect(problems[0].message).toContain("never wrapped");
  });

  it("rejects prose after the first section heading", () => {
    const { problems } = checkShape(index(
      "## Audits and reports",
      "",
      "Some note about this section.",
      "",
      "- [a.md](specs/a.md) — an audit, July 2026.",
    ));
    expect(problems.length).toBe(1);
    expect(problems[0].message).toContain("section heading or an entry");
  });

  it("rejects a second paragraph in the preamble", () => {
    const { problems } = checkShape([
      TITLE,
      "",
      PROSE,
      "",
      "A second paragraph, which two branches could edit at once.",
      "",
      "## Audits and reports",
      "",
      "- [a.md](specs/a.md) — an audit, July 2026.",
    ].join("\n"));
    expect(problems.length).toBe(1);
    expect(problems[0].message).toContain("exactly one line of prose");
  });

  it("reports the same document indexed twice", () => {
    const { problems } = checkShape(index(
      "## Audits and reports",
      "",
      "- [a.md](specs/a.md) — an audit, July 2026.",
      "- [a.md](specs/a.md) — an audit, rewritten, July 2026.",
    ));
    expect(problems.length).toBe(1);
    expect(problems[0].lineNumber).toBe(8);
    expect(problems[0].message).toContain("already indexed on line 7");
  });

  it("reports an entry that links nothing", () => {
    const { problems } = checkShape(index(
      "## Audits and reports",
      "",
      "- an audit, July 2026.",
    ));
    expect(problems.length).toBe(1);
    expect(problems[0].message).toContain("links nothing");
  });

  it("ignores links that leave the tree", () => {
    const { problems, entries } = checkShape(index(
      "## Shipped or superseded designs and decision records",
      "",
      "- [a.md](specs/a.md) — superseded by the [live spec](../specs/a.md).",
    ));
    expect(problems).toEqual([]);
    expect(entries[0].targets).toEqual(["specs/a.md"]);
  });

  it("requires the title", () => {
    const { problems } = checkShape([
      "# Historical documents",
      "",
      PROSE,
      "",
      "## Audits and reports",
      "",
      "- [a.md](specs/a.md) — an audit, July 2026.",
    ].join("\n"));
    expect(problems.length).toBe(1);
    expect(problems[0].lineNumber).toBe(1);
  });
});

describe("coversPath", () => {
  it("covers the document it names", () => {
    expect(coversPath("specs/a.md", "specs/a.md")).toBe(true);
    expect(coversPath("specs/a.md", "specs/b.md")).toBe(false);
  });

  it("covers a whole subtree when it names a directory", () => {
    expect(coversPath("tutorials/", "tutorials/index.md")).toBe(true);
    expect(coversPath("tutorials/", "tutorials/images/notes.md")).toBe(true);
    expect(coversPath("tutorials/", "plans/a.md")).toBe(false);
  });

  it("does not let a document name cover its siblings", () => {
    expect(coversPath("tutorials/index.md", "tutorials/state.md")).toBe(false);
  });
});
