import { assert, assertEquals } from "@std/assert";
import { buildView } from "../lib/view/mod.ts";
import { Session } from "../lib/view/session.ts";
import type { Key } from "../lib/view/keys.ts";
import { renderMarkdownLines } from "../lib/view/languages/markdown/markdown.ts";
import { parseDiff } from "../lib/view/diff.ts";
import {
  buildDiffDocument,
  type DiffWorkspace,
  type WorkspaceCache,
} from "../lib/view/diffdoc.ts";
import { diffSource } from "../lib/view/diffedit.ts";
import { renderLineColored } from "../lib/view/highlight.ts";

const MARKDOWN = [
  "# **Title** &amp;",
  "",
  "> A *quote* with [link](https://example.com) and `code`.",
  "- [x] Done",
  "1) First",
  "",
  "| Name | Value |",
  "| :--- | ---: |",
  "| one | **two** |",
  "",
  "```ts",
  "const x = 1;",
  "```",
].join("\n");

function press(session: Session, ...names: string[]): void {
  for (const name of names) {
    const key: Key = name.length === 1 && name >= " "
      ? { name, char: name }
      : { name };
    session.handleKey(key);
  }
}

Deno.test("markdown rendered view formats blocks and inline content", () => {
  const lines = renderMarkdownLines(MARKDOWN);
  assertEquals(lines.length, MARKDOWN.split("\n").length);
  assertEquals(lines.map((line) => line.text), [
    "Title &",
    "",
    "│ A quote with link and code.",
    "☑ Done",
    "1. First",
    "",
    "│ Name │ Value │",
    "├──────┼───────┤",
    "│ one  │   two │",
    "",
    "",
    "const x = 1;",
    "",
  ]);
  for (const line of lines) {
    assertEquals(
      line.spans.map((span) => span.text).join(""),
      line.text,
      `spans reconstruct ${JSON.stringify(line.text)}`,
    );
  }

  assert(lines[0].spans.some((span) => span.bold), "strong text is bold");
  assert(lines[2].spans.some((span) => span.italic), "emphasis is italic");
  assert(
    lines[2].spans.some((span) => span.underline),
    "link text is underlined",
  );
  assert(
    lines[2].spans.some((span) => span.cls === "string"),
    "inline code has code colour",
  );
  assert(
    lines[6].spans.some((span) => span.bold),
    "table headings are bold",
  );
  assert(lines[0].renderedSourceHidden, "heading levels remain diff-visible");
});

Deno.test("markdown rendered view handles setext, rules, images, and fenced tables", () => {
  const lines = renderMarkdownLines([
    "```",
    "a | b",
    "--- | ---",
    "```",
    "Setext heading &copy;",
    "==============",
    "",
    "---",
    "![diagram](diagram.png) and ~~retired~~",
    "<b>HTML text</b>",
    "",
    "- item",
    "---",
    "# Heading",
    "---",
  ].join("\n"));

  assertEquals(lines.map((line) => line.text), [
    "",
    "a | b",
    "--- | ---",
    "",
    "Setext heading ©",
    "",
    "",
    "────────────────────────────────",
    "▧ diagram and retired",
    "HTML text",
    "",
    "• item",
    "────────────────────────────────",
    "Heading",
    "────────────────────────────────",
  ]);
  assert(
    lines[8].spans.some((span) => span.strikethrough),
    "deleted text is struck through",
  );
  assert(
    renderLineColored(lines[8], true).includes("\x1b[9;"),
    "rich modifiers reach ANSI output",
  );
});

Deno.test("markdown rendered view covers nested blocks and table alignment", () => {
  const lines = renderMarkdownLines([
    "[target]: https://example.com",
    "> > nested **[quote][target]**",
    "- bullet",
    "2. [ ] pending",
    "    indented code",
    "",
    "| Center | Left | Right |",
    "| :---: | :--- | ---: |",
    "| x\\|y | \\*literal\\* | `p|q` |",
    "",
    "\\*literal\\* and <https://example.com>",
    "  ~~~ text",
    "    fenced code",
    "  ~~~~",
  ].join("\n"));

  assertEquals(lines[0].text, "");
  assertEquals(lines[1].text, "│ │ nested quote");
  assert(lines[1].spans.some((span) => span.underline));
  assertEquals(lines[2].text, "• bullet");
  assertEquals(lines[3].text, "2. ☐ pending");
  assertEquals(lines[4].text, "      indented code");
  assert(lines[6].text.includes("Center"));
  assert(lines[7].text.includes("┼"));
  assert(lines[8].text.includes("x|y"));
  assert(lines[8].text.includes("*literal*"));
  assert(lines[8].text.includes("p|q"));
  assertEquals(lines[10].text, "*literal* and https://example.com");
  assertEquals(lines[11].text, "");
  assertEquals(lines[12].text, "  fenced code");
  assertEquals(lines[13].text, "");
});

Deno.test("markdown rendered view follows block containers and literal syntax", () => {
  const lines = renderMarkdownLines([
    "    a | b",
    "    --- | ---",
    "",
    "> ```js",
    "> const x = 1;",
    "> ```",
    "",
    "`&amp;`",
    '<span title="1 > 0">visible</span>',
  ].join("\n"));

  assertEquals(lines.map((line) => line.text), [
    "a | b",
    "--- | ---",
    "",
    "│ ",
    "│ const x = 1;",
    "│ ",
    "",
    "&amp;",
    "visible",
  ]);
  assertEquals(lines[0].spans[0]?.cls, "string");
  assertEquals(lines[1].spans[0]?.cls, "string");
  assertEquals(lines[4].spans[1]?.cls, "string");
});

Deno.test("markdown rendered view preserves nested and multiline structure", () => {
  const nested = renderMarkdownLines([
    "- outer",
    "  - inner",
    "    - deep",
  ].join("\n"));
  assertEquals(nested.map((line) => line.text), [
    "• outer",
    "  • inner",
    "    • deep",
  ]);

  const code = renderMarkdownLines([
    "- outer",
    "",
    "      code",
  ].join("\n"));
  assertEquals(code.map((line) => line.text), ["• outer", "", "  code"]);
  assertEquals(code[2].spans[1]?.cls, "string");

  const paragraph = renderMarkdownLines([
    "This is *emphasis",
    "continued here*.",
  ].join("\n"));
  assertEquals(paragraph.map((line) => line.text), [
    "This is emphasis",
    "continued here.",
  ]);
  assert(paragraph[0].spans.some((span) => span.italic));
  assert(paragraph[1].spans.some((span) => span.italic));

  const comment = renderMarkdownLines(["<!--", "hidden", "-->"].join("\n"));
  assertEquals(comment.map((line) => line.text), ["", "", ""]);
  assert(comment.every((line) => line.renderedSourceHidden));
});

Deno.test("markdown rendered view keeps inline content on its source lines", () => {
  const code = renderMarkdownLines("`first\nsecond`");
  assertEquals(code.map((line) => line.text), ["first", "second"]);
  assert(code.every((line) => line.spans[0]?.cls === "string"));

  const entity = renderMarkdownLines("before&#10;after");
  assertEquals(entity.map((line) => line.text), ["before after"]);

  const html = renderMarkdownLines(
    'before <span\ntitle="x">visible</span> after',
  );
  assertEquals(html.map((line) => line.text), ["before ", "visible after"]);

  const comment = renderMarkdownLines("before <!--\nhidden --> after");
  assertEquals(comment.map((line) => line.text), ["before ", " after"]);

  for (const line of [...code, ...entity, ...html, ...comment]) {
    assertEquals(
      line.spans.map((span) => span.text).join(""),
      line.text,
      `spans reconstruct ${JSON.stringify(line.text)}`,
    );
  }
});

Deno.test("session toggles Markdown between source and rendered views", () => {
  const built = buildView(MARKDOWN, "notes.md");
  const session = new Session(
    built.doc,
    { color: false, showLineNumbers: false },
    { width: 80, height: 10 },
    undefined,
    built.editSource,
  );

  assertEquals(session.doc.lines[0].text, "# **Title** &amp;");
  assertEquals(session.view().viewMode, "source");
  assert(session.view().canRender);

  press(session, "s", "l");
  const selected = session.view().selected?.label;
  assert(selected);
  assertEquals(session.view().left, 8);
  press(session, "v");
  assertEquals(session.doc.lines[0].text, "Title &");
  assertEquals(session.view().viewMode, "rendered");
  assertEquals(session.view().message, "View: rendered");
  assertEquals(session.view().selected?.label, selected);
  assertEquals(session.view().left, 0);

  press(session, "#");
  assertEquals(session.view().lineNumbers?.slice(0, 3), [1, 2, 3]);

  press(session, "enter", "tab");
  assert(session.view().overlay?.sourceView, "card source remains source text");
  assertEquals(session.view().overlay?.lines[0]?.text, "# **Title** &amp;");
  press(session, "escape");

  press(session, "e");
  assertEquals(session.view().viewMode, "source");
  assertEquals(session.doc.lines[0].text, "# **Title** &amp;");
  assert(session.view().cursor, "editing enters source view with a cursor");
  assertEquals(session.view().message, "Source view for editing.");

  press(session, "end", "!", "escape", "v");
  assertEquals(session.view().viewMode, "rendered");
  assertEquals(session.doc.lines[0].text, "Title &!");

  const oneHeading = buildView("# **Heading**", "heading.md");
  const selectionSession = new Session(
    oneHeading.doc,
    { color: false, showLineNumbers: false },
    { width: 40, height: 4 },
    undefined,
    oneHeading.editSource,
  );
  press(selectionSession, "s", "v");
  assertEquals(selectionSession.view().selected?.startCol, 0);
  assertEquals(selectionSession.view().selected?.endCol, 7);
});

Deno.test("session can start rendered and recomputes visible search matches", () => {
  const text = "# A [visible target](hidden-destination)\n";
  const built = buildView(text, "notes.md");
  const session = new Session(
    built.doc,
    { color: false, showLineNumbers: false, viewMode: "rendered" },
    { width: 20, height: 5 },
    undefined,
    built.editSource,
  );

  assertEquals(session.view().viewMode, "rendered");
  assertEquals(session.doc.lines[0].text, "A visible target");
  press(
    session,
    "/",
    "h",
    "i",
    "d",
    "d",
    "e",
    "n",
    "enter",
  );
  assertEquals(session.view().matches?.length, 0);

  press(session, "V");
  assertEquals(session.view().viewMode, "source");
  assertEquals(session.view().matches?.length, 1);
  assertEquals(session.doc.lines[0].text, text.trim());
});

Deno.test("languages without a renderer remain in source view", () => {
  const built = buildView("const value = 1;\n", "value.ts");
  const session = new Session(
    built.doc,
    {
      color: false,
      showLineNumbers: false,
      viewMode: "rendered",
    },
    { width: 40, height: 4 },
    undefined,
    built.editSource,
  );

  assertEquals(session.view().viewMode, "source");
  assertEquals(session.view().canRender, false);
  press(session, "v");
  assertEquals(session.view().viewMode, "source");
  assertEquals(session.view().message, "Rendered view isn't available here.");
  assertEquals(session.doc.lines[0].text, "const value = 1;");
});

const MARKDOWN_DIFF = `diff --git a/notes.md b/notes.md
--- a/notes.md
+++ b/notes.md
@@ -1 +1 @@
-# Old **title**
+# New *title*
`;

Deno.test("rendered Markdown diff retains markers, tints, and source topology", () => {
  const built = buildView(MARKDOWN_DIFF, undefined, true);
  const rendered = built.editSource.render?.(built.doc);
  assert(rendered, "Markdown diff offers a rendered view");
  assertEquals(rendered.text, MARKDOWN_DIFF);
  assertEquals(rendered.lines.length, built.doc.lines.length);
  assertEquals(rendered.lines[4].text, "-# Old **title**");
  assertEquals(rendered.lines[5].text, "+# New *title*");
  assertEquals(rendered.lines[4].bg, "del");
  assertEquals(rendered.lines[5].bg, "add");
  assertEquals(rendered.lines[4].spans[0]?.cls, "diffDel");
  assertEquals(rendered.lines[5].spans[0]?.cls, "diffAdd");
  assertEquals(built.doc.lines[4].text, "-# Old **title**");
  assertEquals(built.doc.lines[5].text, "+# New *title*");
  assertEquals(rendered.flatStructure.length, built.doc.flatStructure.length);

  const renamed = buildView(`diff --git a/notes.md b/notes.ts
--- a/notes.md
+++ b/notes.ts
@@ -1 +1 @@
-# Old **title**
+const title = "new";
`);
  const renderedRename = renamed.editSource.render?.(renamed.doc);
  assert(renderedRename, "a renamed Markdown old side offers rendered view");
  assertEquals(renderedRename.lines[4].text, "-# Old **title**");
  assertEquals(renderedRename.lines[5].text, '+const title = "new";');

  const renameSession = new Session(
    renamed.doc,
    { color: false, showLineNumbers: false },
    { width: 40, height: 6 },
    undefined,
    renamed.editSource,
  );
  press(renameSession, "tab", "tab", "tab", "v");
  assertEquals(renameSession.view().selected?.label, "title");
  assertEquals(renameSession.view().selected?.startCol, 1);
  assertEquals(renameSession.view().selected?.endCol, 21);

  const destinationOnly = buildView(
    `diff --git a/links.md b/links.md
--- a/links.md
+++ b/links.md
@@ -1,2 +1,2 @@
-[target]: https://safe.example
-[open][target]
+[target]: https://evil.example
+[open][target]
`,
    undefined,
    true,
  );
  const renderedDestinationOnly = destinationOnly.editSource.render?.(
    destinationOnly.doc,
  );
  assert(renderedDestinationOnly);
  assertEquals(
    renderedDestinationOnly.lines.slice(4, 8).map((line) => line.text),
    [
      "-[target]: https://safe.example",
      "-[open][target]",
      "+[target]: https://evil.example",
      "+[open][target]",
    ],
  );

  const inlineDestinationOnly = buildView(
    `--- a/links.md
+++ b/links.md
@@ -1 +1 @@
-[open](https://safe.example)
+[open](https://evil.example)
`,
    undefined,
    true,
  );
  const renderedInlineDestinationOnly = inlineDestinationOnly.editSource
    .render?.(inlineDestinationOnly.doc);
  assert(renderedInlineDestinationOnly);
  assertEquals(
    renderedInlineDestinationOnly.lines.slice(3, 5).map((line) => line.text),
    [
      "-[open](https://safe.example)",
      "+[open](https://evil.example)",
    ],
  );

  const noNewline = buildView(
    `--- a/links.md
+++ b/links.md
@@ -1 +1 @@
-[open](https://safe.example)
\\ No newline at end of file
+[open](https://evil.example)
\\ No newline at end of file
`,
    undefined,
    true,
  );
  const renderedNoNewline = noNewline.editSource.render?.(noNewline.doc);
  assert(renderedNoNewline);
  assertEquals(
    renderedNoNewline.lines[3].text,
    "-[open](https://safe.example)",
  );
  assertEquals(
    renderedNoNewline.lines[5].text,
    "+[open](https://evil.example)",
  );

  const labelAndDestination = buildView(
    `--- a/links.md
+++ b/links.md
@@ -1 +1 @@
-[safe](https://safe.example)
+[evil](https://evil.example)
`,
    undefined,
    true,
  );
  const renderedLabelAndDestination = labelAndDestination.editSource.render?.(
    labelAndDestination.doc,
  );
  assert(renderedLabelAndDestination);
  assertEquals(
    renderedLabelAndDestination.lines.slice(3, 5).map((line) => line.text),
    [
      "-[safe](https://safe.example)",
      "+[evil](https://evil.example)",
    ],
  );

  const headingLevel = buildView(
    `--- a/headings.md
+++ b/headings.md
@@ -1 +1 @@
-## Old title
+# New title
`,
    undefined,
    true,
  );
  const renderedHeadingLevel = headingLevel.editSource.render?.(
    headingLevel.doc,
  );
  assert(renderedHeadingLevel);
  assertEquals(
    renderedHeadingLevel.lines.slice(3, 5).map((line) => line.text),
    ["-## Old title", "+# New title"],
  );

  const multilineCode = buildView(
    `--- a/code.md
+++ b/code.md
@@ -1,2 +1,2 @@
 \`first
-second\`
+third\`
`,
    undefined,
    true,
  );
  const renderedMultilineCode = multilineCode.editSource.render?.(
    multilineCode.doc,
  );
  assert(renderedMultilineCode);
  assertEquals(
    renderedMultilineCode.lines.slice(3, 6).map((line) => line.text),
    [" first", "-second", "+third"],
  );
});

Deno.test("diff expansion rebuilds the active rendered Markdown view", () => {
  const fileText = "# Title\nalpha\nnew **value**\nomega\n";
  const diffText = `diff --git a/notes.md b/notes.md
--- a/notes.md
+++ b/notes.md
@@ -3 +3 @@
-old value
+new **value**
`;
  const absPath = "/workspace/notes.md";
  const workspace: DiffWorkspace = {
    resolve: () => absPath,
    read: (path) => path === absPath ? fileText : null,
  };
  const cache: WorkspaceCache = new Map();
  const model = parseDiff(diffText);
  assert(model);
  const { doc, edit } = buildDiffDocument(
    diffText,
    model,
    workspace,
    cache,
  );
  const session = new Session(
    doc,
    { color: false, showLineNumbers: false },
    { width: 80, height: 10 },
    undefined,
    diffSource(workspace, edit, cache, undefined, true),
  );

  press(session, "v");
  assertEquals(session.doc.lines[5].text, "+new value");
  press(session, "#", "#");
  assertEquals(session.view().lineNumbers?.[4], null);
  assertEquals(session.view().lineNumbers?.[5], 3);
  assert(session.view().canExpand, "the compact hunk offers more context");
  press(session, "ctrl-l");

  assertEquals(session.view().viewMode, "rendered");
  const sourceLines = session.doc.text.split("\n");
  const titleLine = sourceLines.findIndex((line) => line.includes("# Title"));
  assert(titleLine >= 0, "expansion revealed the file heading");
  assertEquals(session.doc.lines[titleLine].text, " Title");
  assert(
    session.doc.lines.some((line) => line.text === "+new value"),
    "the changed Markdown line remains rendered",
  );
});
