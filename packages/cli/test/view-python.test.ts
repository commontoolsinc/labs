/**
 * Python highlighting for direct files, diffs, and live edits. The scanner is
 * lenient and lossless, including while multiline strings are incomplete.
 */
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  createPythonHighlighter,
  isPythonPath,
  pythonDocument,
  pythonHighlightLines,
} from "../lib/view/languages/python/python.ts";
import { languageForFile } from "../lib/view/languages/language.ts";
import type { Line, TokenClass } from "../lib/view/model.ts";
import { parseDiff } from "../lib/view/diff.ts";
import { buildDiffDocument, type DiffWorkspace } from "../lib/view/diffdoc.ts";
import { createDiffHighlighter, diffSource } from "../lib/view/diffedit.ts";

function verbatim(lines: readonly Line[]): string {
  return lines.map((line) => line.spans.map((span) => span.text).join(""))
    .join("\n");
}

function classesOf(lines: readonly Line[], text: string): Set<TokenClass> {
  const classes = new Set<TokenClass>();
  for (const line of lines) {
    for (const span of line.spans) {
      if (span.text === text) classes.add(span.cls);
    }
  }
  return classes;
}

function classOnLine(
  lines: readonly Line[],
  lineText: string,
  token: string,
): TokenClass | undefined {
  return lines.find((line) => line.text === lineText)?.spans.find((span) =>
    span.text === token
  )?.cls;
}

function tempWorkspace(root: string): DiffWorkspace {
  return {
    resolve: (path) => join(root, path),
    read: (path) => {
      try {
        return Deno.readTextFileSync(path);
      } catch {
        return null;
      }
    },
  };
}

Deno.test("python: path matching recognises source, stub, and windowed files", () => {
  for (const path of ["main.py", "types.pyi", "app.pyw", "/tmp/UPPER.PY"]) {
    assert(isPythonPath(path), path);
  }
  for (const path of ["module.pyc", "archive.pyz", "notes.md", undefined]) {
    assert(!isPythonPath(path), String(path));
  }
});

Deno.test("python: the language registry selects Python extensions", () => {
  const python = languageForFile("main.py");
  assertEquals(python.id, "python");
  assertEquals(languageForFile("types.pyi").id, "python");
  assertEquals(languageForFile("app.pyw").id, "python");
  assertEquals(languageForFile("main.ts").id, "typescript");
  assertEquals(languageForFile(undefined).id, "plain-text");
  assertEquals(
    verbatim(python.createHighlighter("answer = True").lines),
    "answer = True",
  );
});

Deno.test("python: declarations, keywords, calls, properties, and comments colour", () => {
  const source = [
    "#!/usr/bin/env python3",
    "@decorator",
    'async def greet(name: str = "world") -> str:',
    "    if name is None or not name:",
    "        raise ValueError(name)",
    "    return name.upper()  # ready",
    "",
    "class Greeter:",
    "    pass",
  ].join("\n");
  const lines = pythonHighlightLines(source);

  assertEquals([...classesOf(lines, "#!/usr/bin/env python3")], ["comment"]);
  assertEquals([...classesOf(lines, "@")], ["operator"]);
  assertEquals([...classesOf(lines, "decorator")], ["callName"]);
  assertEquals([...classesOf(lines, "async")], ["keyword"]);
  assertEquals([...classesOf(lines, "def")], ["storageKeyword"]);
  assertEquals([...classesOf(lines, "greet")], ["functionName"]);
  assertEquals([...classesOf(lines, "if")], ["controlKeyword"]);
  assertEquals([...classesOf(lines, "is")], ["operator"]);
  assertEquals([...classesOf(lines, "None")], ["keyword"]);
  assertEquals([...classesOf(lines, "ValueError")], ["callName"]);
  assertEquals([...classesOf(lines, "upper")], ["propertyName"]);
  assertEquals([...classesOf(lines, "# ready")], ["comment"]);
  assertEquals([...classesOf(lines, "class")], ["storageKeyword"]);
  assertEquals([...classesOf(lines, "Greeter")], ["interfaceName"]);
  assertEquals(verbatim(lines), source);
});

Deno.test("python: current string prefixes and escapes remain single tokens", () => {
  const source = [
    String.raw`plain = "a\"b\\c"`,
    String.raw`raw = r"\w+\s"`,
    String.raw`bytes_value = br"\x00"`,
    `formatted = f"{value!r}"`,
    `template = tr"{value}"`,
    `legacy = u"text"`,
  ].join("\n");
  const lines = pythonHighlightLines(source);

  assertEquals([...classesOf(lines, String.raw`"a\"b\\c"`)], ["string"]);
  assertEquals([...classesOf(lines, String.raw`r"\w+\s"`)], ["string"]);
  assertEquals([...classesOf(lines, String.raw`br"\x00"`)], ["string"]);
  assertEquals([...classesOf(lines, `f"{value!r}"`)], ["template"]);
  assertEquals([...classesOf(lines, `tr"{value}"`)], ["template"]);
  assertEquals([...classesOf(lines, `u"text"`)], ["string"]);
  assertEquals(verbatim(lines), source);
});

Deno.test("python: multiline strings carry state across blank lines", () => {
  const source = [
    'message = """first',
    "",
    "second # text, not a comment",
    'third"""',
    "answer = 42",
  ].join("\n");
  const lines = pythonHighlightLines(source);

  assertEquals(lines[1], { text: "", spans: [] });
  assertEquals(
    [...classesOf(lines, "second # text, not a comment")],
    ["string"],
  );
  assertEquals([...classesOf(lines, "answer")], ["identifier"]);
  assertEquals([...classesOf(lines, "42")], ["number"]);
  assertEquals(verbatim(lines), source);
});

Deno.test("python: CRLF backslash continuations stay inside strings", () => {
  const continuation = "\\\r\n";
  const source = `plain = "left${continuation}right"\r\n` +
    `formatted = f"{1${continuation}+ 2}"`;
  const lines = pythonHighlightLines(source);

  assertEquals([...classesOf(lines, 'right"')], ["string"]);
  assertEquals([...classesOf(lines, '+ 2}"')], ["template"]);
  assertEquals(verbatim(lines), source);
});

Deno.test("python: formatted strings accept nested same-quote expressions", () => {
  const source = [
    'value = f"{items["key"]!r:>{width}}"',
    `nested = f"{f'{value=}'}"`,
    'filled = f"{value:[<10}"',
    String.raw`escaped = f"\{items["key"]}"`,
  ].join("\n");
  const lines = pythonHighlightLines(source);

  assertEquals(
    [...classesOf(lines, 'f"{items["key"]!r:>{width}}"')],
    ["template"],
  );
  assertEquals(
    [...classesOf(lines, `f"{f'{value=}'}"`)],
    ["template"],
  );
  assertEquals([...classesOf(lines, 'f"{value:[<10}"')], ["template"]);
  assertEquals(
    [...classesOf(lines, String.raw`f"\{items["key"]}"`)],
    ["template"],
  );
  assertEquals(verbatim(lines), source);
});

Deno.test("python: formatted replacement fields can cross physical lines", () => {
  const source = [
    'value = f"{',
    "    first +  # comment",
    "    second",
    '}"',
    "answer = True",
  ].join("\n");
  const lines = pythonHighlightLines(source);

  assertEquals([...classesOf(lines, "    first +  # comment")], ["template"]);
  assertEquals([...classesOf(lines, "    second")], ["template"]);
  assertEquals([...classesOf(lines, '}"')], ["template"]);
  assertEquals([...classesOf(lines, "True")], ["boolean"]);
  assertEquals(verbatim(lines), source);
});

Deno.test("python: numeric forms and ellipsis use literal classes", () => {
  const source =
    "values = (0, 1_000, 0b_1010, 0o755, 0xCA_FE, .5, 1., 1.5e-2, 3j, ...)";
  const lines = pythonHighlightLines(source);

  for (
    const number of [
      "0",
      "1_000",
      "0b_1010",
      "0o755",
      "0xCA_FE",
      ".5",
      "1.",
      "1.5e-2",
      "3j",
    ]
  ) {
    assertEquals([...classesOf(lines, number)], ["number"], number);
  }
  assertEquals([...classesOf(lines, "...")], ["keyword"]);
  assertEquals(verbatim(lines), source);
});

Deno.test("python: brackets retain rainbow depth and Unicode columns", () => {
  const source = 'π = call([{"😀": value}])';
  const [line] = pythonHighlightLines(source);
  const brackets = line.spans.filter((span) => span.cls === "bracket");

  assertEquals(
    brackets.map((span) => [span.text, span.bracketDepth]),
    [
      ["(", 0],
      ["[", 1],
      ["{", 2],
      ["}", 2],
      ["]", 1],
      [")", 0],
    ],
  );
  const value = line.spans.find((span) => span.text === "value")!;
  assertEquals(value.col, [...source.slice(0, source.indexOf("value"))].length);
  assertEquals(verbatim([line]), source);
});

Deno.test("python: soft keywords remain identifiers outside statements", () => {
  const source = [
    "match subject:",
    "    case Point(x, y):",
    "        pass",
    "type Pair[T] = tuple[T, T]",
    "match = 1",
    "match = lambda x: x",
    "match  \\",
    "    = lambda x: x",
    "match, other = lambda: 1",
    "match, \\",
    "    other = lambda: 1",
    "match.subject",
    "match + 1",
    "match: object",
    "match()",
    "match(subject):",
    "    case Point():",
    "match lambda x=1: x:",
    "    case 1:",
    "        pass",
    "match value if flag else lambda arg=1: arg:",
    "    case _: pass",
    "match value, lambda arg=1: arg:",
    "    case _: pass",
    "match lambda outer=lambda inner=1: inner: outer:",
    "    case _: pass",
    "match x := 1:",
    "    case 1: pass",
    "match left == right:",
    "    case True: pass",
    "match call(x=1):",
    "    case _: pass",
    "match (",
    "    subject",
    "):",
    "    case Point(",
    "        x,",
    "    ):",
    "        pass",
    "match \\",
    "    subject:",
    "    case (  # grouped pattern",
    "        Point()",
    "    ):",
    "        pass",
    "case()",
    "case: int",
    "case += 1",
    "case = lambda x: x",
    "match.subject: int",
    "case[index]: str",
    "{",
    "    match + 1: value,",
    "}",
    "type(value)",
    "type[index]",
    "type \\",
    "    Explicit = int",
    "type Continued \\",
    "    = str",
    "type Generic[T] \\",
    "    = list[T]",
    "value = 1; type Result = int",
    "if True: type Inline = str",
  ].join("\n");
  const lines = pythonHighlightLines(source);

  assert(classesOf(lines, "match").has("controlKeyword"));
  assert(classesOf(lines, "match").has("identifier"));
  assert(classesOf(lines, "match").has("callName"));
  assert(classesOf(lines, "case").has("controlKeyword"));
  assert(classesOf(lines, "case").has("callName"));
  assert(classesOf(lines, "type").has("storageKeyword"));
  assert(classesOf(lines, "type").has("callName"));
  assert(classesOf(lines, "type").has("identifier"));
  assertEquals(classOnLine(lines, "match.subject", "match"), "identifier");
  assertEquals(classOnLine(lines, "match + 1", "match"), "identifier");
  assertEquals(
    classOnLine(lines, "match = lambda x: x", "match"),
    "identifier",
  );
  assertEquals(classOnLine(lines, "match  \\", "match"), "identifier");
  assertEquals(
    classOnLine(lines, "match, other = lambda: 1", "match"),
    "identifier",
  );
  assertEquals(classOnLine(lines, "match, \\", "match"), "identifier");
  assertEquals(classOnLine(lines, "match: object", "match"), "identifier");
  assertEquals(classOnLine(lines, "case: int", "case"), "identifier");
  assertEquals(classOnLine(lines, "case += 1", "case"), "identifier");
  assertEquals(
    classOnLine(lines, "case = lambda x: x", "case"),
    "identifier",
  );
  assertEquals(
    classOnLine(lines, "match.subject: int", "match"),
    "identifier",
  );
  assertEquals(classOnLine(lines, "case[index]: str", "case"), "identifier");
  assertEquals(
    classOnLine(lines, "    match + 1: value,", "match"),
    "identifier",
  );
  assertEquals(classOnLine(lines, "match (", "match"), "controlKeyword");
  assertEquals(
    classOnLine(lines, "match lambda x=1: x:", "match"),
    "controlKeyword",
  );
  assertEquals(
    classOnLine(
      lines,
      "match value if flag else lambda arg=1: arg:",
      "match",
    ),
    "controlKeyword",
  );
  assertEquals(
    classOnLine(lines, "match value, lambda arg=1: arg:", "match"),
    "controlKeyword",
  );
  assertEquals(
    classOnLine(
      lines,
      "match lambda outer=lambda inner=1: inner: outer:",
      "match",
    ),
    "controlKeyword",
  );
  assertEquals(classOnLine(lines, "match x := 1:", "match"), "controlKeyword");
  assertEquals(
    classOnLine(lines, "match left == right:", "match"),
    "controlKeyword",
  );
  assertEquals(
    classOnLine(lines, "match call(x=1):", "match"),
    "controlKeyword",
  );
  assertEquals(
    classOnLine(lines, "    case Point(", "case"),
    "controlKeyword",
  );
  assertEquals(classOnLine(lines, "match \\", "match"), "controlKeyword");
  assertEquals(
    classOnLine(lines, "    case (  # grouped pattern", "case"),
    "controlKeyword",
  );
  assertEquals(classOnLine(lines, "type[index]", "type"), "identifier");
  assertEquals(classOnLine(lines, "type \\", "type"), "storageKeyword");
  assertEquals(
    classOnLine(lines, "type Continued \\", "type"),
    "storageKeyword",
  );
  assertEquals(
    classOnLine(lines, "type Generic[T] \\", "type"),
    "storageKeyword",
  );
  assertEquals(
    classOnLine(lines, "value = 1; type Result = int", "type"),
    "storageKeyword",
  );
  assertEquals(
    classOnLine(lines, "if True: type Inline = str", "type"),
    "storageKeyword",
  );
  const crlfAssignment = pythonHighlightLines(
    "match, \\\r\n    other = lambda: 1",
  );
  assertEquals(
    classOnLine(crlfAssignment, "match, \\\r", "match"),
    "identifier",
  );
  assertEquals(verbatim(lines), source);
});

Deno.test("python: soft-keyword scanners handle nested and incomplete forms", () => {
  const misplacedType = pythonHighlightLines("value type Alias = int");
  assertEquals([...classesOf(misplacedType, "type")], ["identifier"]);

  const genericAlias = [
    "type Alias[",
    '    T: tuple[str, "]"],',
    "    # punctuation in this comment does not close the parameters: ]",
    "] = list[T]",
  ].join("\n");
  const genericLines = pythonHighlightLines(genericAlias);
  assertEquals([...classesOf(genericLines, "type")], ["storageKeyword"]);
  assertEquals(verbatim(genericLines), genericAlias);

  const commentedMatch = pythonHighlightLines(
    "match subject # fake suite colon:",
  );
  assertEquals([...classesOf(commentedMatch, "match")], ["identifier"]);

  const stringMatch = pythonHighlightLines('match "fake:"');
  assertEquals([...classesOf(stringMatch, "match")], ["identifier"]);

  const incompleteMatch = pythonHighlightLines("match subject");
  assertEquals([...classesOf(incompleteMatch, "match")], ["identifier"]);

  const escapedFormatSpec = 'value = f"{item:{{x}" + after';
  const formatLines = pythonHighlightLines(escapedFormatSpec);
  assertEquals([...classesOf(formatLines, "after")], ["identifier"]);
  assertEquals(verbatim(formatLines), escapedFormatSpec);

  const crlfAlias = "type Alias \\\r\n    = int";
  assertEquals(
    [...classesOf(pythonHighlightLines(crlfAlias), "type")],
    ["storageKeyword"],
  );

  for (const source of [String.raw`type \ Alias = int`, "type"]) {
    const lines = pythonHighlightLines(source);
    assertEquals([...classesOf(lines, "type")], ["identifier"]);
    assertEquals(verbatim(lines), source);
  }
});

Deno.test("python: malformed and incomplete input stays lossless", () => {
  for (
    const source of [
      "value = 'unterminated\nnext = True",
      'value = """unterminated\nstill text',
      "f'{unclosed'",
      "0x 1e+ @@@",
      "\ud800",
      "",
      " \t\f",
    ]
  ) {
    const document = pythonDocument(source);
    assertEquals(verbatim(document.lines), source);
    assertEquals(document.structure, []);
  }
});

Deno.test("python: incomplete formatted fields recover without dropping text", () => {
  const source = [
    "value = match",
    'escaped = f"{{literal}}"',
    'line_break = f"{value',
    "next = True",
    'commented = f"""{value  # field comment',
    '}"""',
    String.raw`backslash = f"{value\}}"`,
    "lower_hex = 0xdead_beef",
    "bare = 😀",
  ].join("\n");
  const lines = pythonHighlightLines(source);

  assert(classesOf(lines, "match").has("identifier"));
  assertEquals([...classesOf(lines, 'f"{{literal}}"')], ["template"]);
  assertEquals([...classesOf(lines, "True")], ["boolean"]);
  assertEquals([...classesOf(lines, "0xdead_beef")], ["number"]);
  assertEquals(verbatim(lines), source);
});

Deno.test("python: live file highlighting re-baselines multiline state", () => {
  const before = 'value = """first\nsecond\n"""\n';
  const after = 'value = "first"\nsecond = True\n';
  const highlighter = createPythonHighlighter(before);

  assertEquals([...classesOf(highlighter.lines, "second")], ["string"]);
  const updated = highlighter.update(after);
  assertEquals([...classesOf(updated, "second")], ["identifier"]);
  assertEquals([...classesOf(updated, "True")], ["boolean"]);
  assertEquals(verbatim(updated), after);
});

Deno.test("python: unavailable diff files use context for multiline strings", () => {
  const diff = [
    "diff --git a/example.py b/example.py",
    "--- a/example.py",
    "+++ b/example.py",
    "@@ -1,3 +1,3 @@",
    ' value = """',
    "-old text",
    "+new text",
    ' """',
    "",
  ].join("\n");
  const model = parseDiff(diff)!;
  const workspace: DiffWorkspace = {
    resolve: () => null,
    read: () => null,
  };
  const { doc } = buildDiffDocument(diff, model, workspace);

  assertEquals([...classesOf(doc.lines, "old text")], ["string"]);
  assertEquals([...classesOf(doc.lines, "new text")], ["string"]);
  assertEquals(verbatim(doc.lines), diff);
});

Deno.test("python: a seedless diff highlighter joins both hunk sides", () => {
  const diff = [
    "diff --git a/example.py b/example.py",
    "--- a/example.py",
    "+++ b/example.py",
    "@@ -1,3 +1,3 @@",
    ' value = """',
    "-old text",
    "+new text",
    ' """',
    "",
  ].join("\n");
  const highlighter = createDiffHighlighter(diff);

  assertEquals([...classesOf(highlighter.lines, "old text")], ["string"]);
  assertEquals([...classesOf(highlighter.lines, "new text")], ["string"]);
  assertEquals(verbatim(highlighter.lines), diff);

  const renamedHeader = diff.replace(
    "diff --git a/example.py b/example.py",
    "diff --git a/renamed.py b/renamed.py",
  );
  assertEquals(verbatim(highlighter.update(renamedHeader)), renamedHeader);
  assertEquals(verbatim(highlighter.update("not a diff")), "not a diff");
});

Deno.test("python: live diff edits retain complete-file multiline state", () => {
  const root = Deno.makeTempDirSync();
  try {
    const file = ['value = """', "new text", '"""', ""].join("\n");
    Deno.writeTextFileSync(join(root, "example.py"), file);
    const diff = [
      "diff --git a/example.py b/example.py",
      "--- a/example.py",
      "+++ b/example.py",
      "@@ -2 +2 @@",
      "-old text",
      "+new text",
      "",
    ].join("\n");
    const model = parseDiff(diff)!;
    const workspace = tempWorkspace(root);
    const { doc, edit } = buildDiffDocument(diff, model, workspace);
    const source = diffSource(workspace, edit);
    const highlighter = source.createHighlighter!(diff, doc.lines);

    const editedText = diff.replace("+new text", "+newer text");
    const edited = highlighter.update(editedText);
    assertEquals([...classesOf(edited, "newer text")], ["string"]);
    assertEquals(verbatim(edited), editedText);

    const reparsed = source.parse(editedText);
    assertEquals([...classesOf(reparsed.lines, "newer text")], ["string"]);
    assertEquals(verbatim(reparsed.lines), editedText);
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("python: deferred diff parsing keeps old state across a rename", () => {
  const root = Deno.makeTempDirSync();
  try {
    const file = ['value = """', "new text", '"""', ""].join("\n");
    Deno.writeTextFileSync(join(root, "example.txt"), file);
    const diff = [
      "diff --git a/example.py b/example.txt",
      "--- a/example.py",
      "+++ b/example.txt",
      "@@ -2 +2 @@",
      "-old text",
      "+new text",
      "",
    ].join("\n");
    const model = parseDiff(diff)!;
    const workspace = tempWorkspace(root);
    const { doc, edit } = buildDiffDocument(diff, model, workspace);
    const source = diffSource(workspace, edit);
    const highlighter = source.createHighlighter!(diff, doc.lines);

    assertEquals([...classesOf(doc.lines, "old text")], ["string"]);
    const editedText = diff.replace("+new text", "+newer text");
    const edited = highlighter.update(editedText);
    assertEquals([...classesOf(edited, "old text")], ["string"]);

    const reparsed = source.parse(editedText);
    assertEquals([...classesOf(reparsed.lines, "old text")], ["string"]);
    assertEquals(verbatim(reparsed.lines), editedText);
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("python: live edits account for line shifts across later hunks", () => {
  const root = Deno.makeTempDirSync();
  try {
    const file = [
      'value = """',
      "first",
      "middle",
      "last",
      '"""',
      "",
    ].join("\n");
    Deno.writeTextFileSync(join(root, "example.py"), file);
    const diff = [
      "diff --git a/example.py b/example.py",
      "--- a/example.py",
      "+++ b/example.py",
      "@@ -2 +2 @@",
      "-old first",
      "+first",
      "@@ -4 +4 @@",
      "-old last",
      "+last",
      "",
    ].join("\n");
    const model = parseDiff(diff)!;
    const workspace = tempWorkspace(root);
    const { doc, edit } = buildDiffDocument(diff, model, workspace);
    const highlighter = diffSource(workspace, edit).createHighlighter!(
      diff,
      doc.lines,
    );
    const edited = [
      "diff --git a/example.py b/example.py",
      "--- a/example.py",
      "+++ b/example.py",
      "@@ -2 +2,2 @@",
      "-old first",
      "+first",
      "+inserted",
      "@@ -4 +5 @@",
      "-old last",
      "+last",
      "",
    ].join("\n");
    const lines = highlighter.update(edited);

    assertEquals([...classesOf(lines, "inserted")], ["string"]);
    assertEquals([...classesOf(lines, "last")], ["string"]);
    assertEquals(verbatim(lines), edited);
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});
