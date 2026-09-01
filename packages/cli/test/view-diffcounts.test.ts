/** Tests the three line-count policies used by the diff jump list. */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { diffCounts } from "../lib/view/diffcounts.ts";
import { parseDiff } from "../lib/view/diff.ts";
import { buildDiffDocument } from "../lib/view/diffdoc.ts";

/** Computes every count policy over one highlighted diff. */
function countsFor(text: string) {
  const model = parseDiff(text)!;
  const { doc } = buildDiffDocument(text, model, {
    resolve: () => null,
    read: () => null,
  });
  return {
    normal: diffCounts(text, doc.lines, "normal"),
    whitespace: diffCounts(text, doc.lines, "whitespace"),
    comments: diffCounts(text, doc.lines, "comments"),
  };
}

describe("diffcounts", () => {
  it("discounts whitespace-only pairs within each file", () => {
    const diff = [
      "diff --git a/a.ts b/a.ts",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1 +1 @@",
      "-const value = 1; // same",
      "+const   value = 1; // same",
      "",
    ].join("\n");

    const counts = countsFor(diff);

    expect(counts.normal.totals).toEqual({ adds: 1, dels: 1 });
    expect(counts.whitespace.totals).toEqual({ adds: 0, dels: 0 });
  });

  it("discounts comment-only lines and comment-only edits", () => {
    const diff = [
      "diff --git a/a.ts b/a.ts",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1,2 +1,2 @@",
      "-run(); // before",
      "-// removed explanation",
      "+run(); // after",
      "+  // replacement explanation",
      "",
    ].join("\n");

    const counts = countsFor(diff);

    expect(counts.whitespace.totals).toEqual({ adds: 2, dels: 2 });
    expect(counts.comments.totals).toEqual({ adds: 0, dels: 0 });
  });

  it("ignores documentation comments without treating strings as comments", () => {
    const diff = [
      "diff --git a/a.ts b/a.ts",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1,2 +1,2 @@",
      "-/** old documentation */",
      '-const url = "https://old.example";',
      "+/** new documentation */",
      '+const url = "https://new.example";',
      "",
    ].join("\n");

    const counts = countsFor(diff);

    expect(counts.comments.totals).toEqual({ adds: 1, dels: 1 });
  });

  it("counts Markdown headings even though they share a display style", () => {
    const diff = [
      "diff --git a/readme.md b/readme.md",
      "--- a/readme.md",
      "+++ b/readme.md",
      "@@ -1 +1 @@",
      "-# Old heading",
      "+# New heading",
      "",
    ].join("\n");

    const counts = countsFor(diff);

    expect(counts.comments.totals).toEqual({ adds: 1, dels: 1 });
  });

  it("recognizes comments in files that use plain-text highlighting", () => {
    const diff = [
      "diff --git a/main.rs b/main.rs",
      "--- a/main.rs",
      "+++ b/main.rs",
      "@@ -1 +1 @@",
      "-fn main() {} // old comment",
      "+fn main() {} // new comment",
      "diff --git a/page.html b/page.html",
      "--- a/page.html",
      "+++ b/page.html",
      "@@ -1 +1 @@",
      "-<!-- old note -->",
      "+<!-- new note -->",
      "",
    ].join("\n");

    const counts = countsFor(diff);

    expect(counts.comments.totals).toEqual({ adds: 0, dels: 0 });
  });

  it("does not treat an unquoted URL as a comment", () => {
    const diff = [
      "diff --git a/style.scss b/style.scss",
      "--- a/style.scss",
      "+++ b/style.scss",
      "@@ -1 +1 @@",
      "-background: url(https://old.example/image.png);",
      "+background: url(https://new.example/image.png);",
      "",
    ].join("\n");

    const counts = countsFor(diff);

    expect(counts.comments.totals).toEqual({ adds: 1, dels: 1 });
  });

  it("uses highlighter decisions for languages it understands", () => {
    const diff = [
      "diff --git a/config.yaml b/config.yaml",
      "--- a/config.yaml",
      "+++ b/config.yaml",
      "@@ -1 +1 @@",
      "-value: foo#old",
      "+value: foo#new",
      "",
    ].join("\n");

    const counts = countsFor(diff);

    expect(counts.comments.totals).toEqual({ adds: 1, dels: 1 });
  });

  it("tracks multiline fallback comments on each side of a hunk", () => {
    const diff = [
      "diff --git a/main.rs b/main.rs",
      "--- a/main.rs",
      "+++ b/main.rs",
      "@@ -1,3 +1,3 @@",
      " /*",
      "- * old note",
      "+ * new note",
      "  */",
      "diff --git a/page.html b/page.html",
      "--- a/page.html",
      "+++ b/page.html",
      "@@ -1,3 +1,3 @@",
      " <!--",
      "-old note",
      "+new note",
      " -->",
      "",
    ].join("\n");

    const counts = countsFor(diff);

    expect(counts.comments.totals).toEqual({ adds: 0, dels: 0 });
  });

  it("preserves comment markers inside Rust raw strings", () => {
    const diff = [
      "diff --git a/main.rs b/main.rs",
      "--- a/main.rs",
      "+++ b/main.rs",
      "@@ -1 +1 @@",
      '-const TEXT: &str = r#"a " // old"#;',
      '+const TEXT: &str = r#"a " // new"#;',
      "",
    ].join("\n");

    const counts = countsFor(diff);

    expect(counts.comments.totals).toEqual({ adds: 1, dels: 1 });
  });

  it("preserves hash operators in shell parameter expansions", () => {
    const diff = [
      "diff --git a/run.sh b/run.sh",
      "--- a/run.sh",
      "+++ b/run.sh",
      "@@ -1 +1 @@",
      "-echo ${value#old}",
      "+echo ${value#new}",
      "",
    ].join("\n");

    const counts = countsFor(diff);

    expect(counts.comments.totals).toEqual({ adds: 1, dels: 1 });
  });

  it("uses each side's comment syntax when a rename changes extensions", () => {
    const diff = [
      "diff --git a/main.rs b/main.ts",
      "--- a/main.rs",
      "+++ b/main.ts",
      "@@ -1 +1 @@",
      "-run(); // old Rust note",
      "+run(); // new TypeScript note",
      "",
    ].join("\n");

    const counts = countsFor(diff);

    expect(counts.comments.totals).toEqual({ adds: 0, dels: 0 });
  });

  it("preserves HTML comment syntax inside Markdown code fences", () => {
    const diff = [
      "diff --git a/readme.md b/readme.md",
      "--- a/readme.md",
      "+++ b/readme.md",
      "@@ -1,3 +1,3 @@",
      " ```text",
      "-<!-- old literal -->",
      "+<!-- new literal -->",
      " ```",
      "",
    ].join("\n");

    const counts = countsFor(diff);

    expect(counts.comments.totals).toEqual({ adds: 1, dels: 1 });
  });

  it("ignores HTML comments after Markdown inline code", () => {
    const diff = [
      "diff --git a/readme.md b/readme.md",
      "--- a/readme.md",
      "+++ b/readme.md",
      "@@ -1 +1 @@",
      "-`same code` <!-- old note -->",
      "+`same code` <!-- new note -->",
      "",
    ].join("\n");

    const counts = countsFor(diff);

    expect(counts.comments.totals).toEqual({ adds: 0, dels: 0 });
  });

  it("preserves HTML comment syntax inside indented Markdown code", () => {
    const diff = [
      "diff --git a/readme.md b/readme.md",
      "--- a/readme.md",
      "+++ b/readme.md",
      "@@ -1 +1 @@",
      "-    <!-- old literal -->",
      "+    <!-- new literal -->",
      "",
    ].join("\n");

    const counts = countsFor(diff);

    expect(counts.comments.totals).toEqual({ adds: 1, dels: 1 });
  });

  it("preserves hash-prefixed data inside shell heredocs", () => {
    const diff = [
      "diff --git a/run.sh b/run.sh",
      "--- a/run.sh",
      "+++ b/run.sh",
      "@@ -1,3 +1,3 @@",
      " cat <<EOF",
      "-# old data",
      "+# new data",
      " EOF",
      "",
    ].join("\n");

    const counts = countsFor(diff);

    expect(counts.comments.totals).toEqual({ adds: 1, dels: 1 });
  });

  it("tracks nested block comments in Rust", () => {
    const diff = [
      "diff --git a/main.rs b/main.rs",
      "--- a/main.rs",
      "+++ b/main.rs",
      "@@ -1,2 +1,2 @@",
      " /* outer /* inner */",
      "-old outer */",
      "+new outer */",
      "",
    ].join("\n");

    const counts = countsFor(diff);

    expect(counts.comments.totals).toEqual({ adds: 0, dels: 0 });
  });

  it("discounts moved code across files when comments are ignored", () => {
    const diff = [
      "diff --git a/a.ts b/a.ts",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1 +0,0 @@",
      "-moved();",
      "diff --git a/b.ts b/b.ts",
      "--- a/b.ts",
      "+++ b/b.ts",
      "@@ -0,0 +1 @@",
      "+ moved ( ) ; // relocated",
      "",
    ].join("\n");

    const counts = countsFor(diff);

    expect(counts.whitespace.totals).toEqual({ adds: 1, dels: 1 });
    expect(counts.comments.totals).toEqual({ adds: 0, dels: 0 });
    expect(counts.comments.files).toEqual([
      { adds: 0, dels: 0 },
      { adds: 0, dels: 0 },
    ]);
  });
});
