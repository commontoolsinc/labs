/**
 * Language selection: `languageForFile` picks a language by extension, uses
 * plain text for unknown named files, and keeps TypeScript for unnamed pipes.
 * `distinctLanguages` dedupes the languages a diff touches, and
 * `diffSemanticsFor` composes the diff view's semantic layer from the languages
 * present, scoped to each one's files.
 */
import { assert, assertEquals, assertThrows } from "@std/assert";
import { join } from "@std/path";
import {
  diffSemanticsFor,
  distinctLanguages,
  languageForFile,
  renderedLinesFor,
} from "../lib/view/languages/language.ts";
import { typeScriptLanguage } from "../lib/view/languages/typescript/language.ts";
import { markdownLanguage } from "../lib/view/languages/markdown/language.ts";
import { jsonLanguage } from "../lib/view/languages/json/language.ts";
import { yamlLanguage } from "../lib/view/languages/yaml/language.ts";
import { pythonLanguage } from "../lib/view/languages/python/language.ts";
import { plainTextLanguage } from "../lib/view/languages/plain-text/language.ts";
import {
  buildDiffDocument,
  type DiffMaps,
  type DiffWorkspace,
} from "../lib/view/diffdoc.ts";
import { parseDiff } from "../lib/view/diff.ts";
import type { Line } from "../lib/view/model.ts";

Deno.test("languageForFile: named files resolve and unnamed input defaults to TypeScript", () => {
  for (const ts of ["a.ts", "a.tsx", "a.mts", "a.cts", "a.js", "a.jsx"]) {
    assertEquals(languageForFile(ts).id, "typescript", ts);
  }
  assertEquals(languageForFile("README.md").id, "markdown");
  assertEquals(languageForFile("deno.jsonc").id, "json");
  assertEquals(languageForFile("workflow.yml").id, "yaml");
  assertEquals(languageForFile("script.py").id, "python");
  assertEquals(languageForFile("notes.xyz").id, "plain-text");
  assertEquals(languageForFile("LICENSE").id, "plain-text");
  assertEquals(languageForFile(undefined).id, "typescript");
});

Deno.test("languageForFile: named JavaScript uses the TypeScript-family parser", () => {
  const source = "export const answer = 42;\n";
  const doc = languageForFile("answer.js").parseDocument(source, "answer.js");
  assertEquals(doc.text, source);
  assert(doc.lines[0].spans.some((span) => span.cls === "storageKeyword"));
});

Deno.test("distinctLanguages: dedupes in first-seen order", () => {
  const languages = distinctLanguages([
    "a.ts",
    "b.ts",
    "c.md",
    "d.json",
    "e.yaml",
    "f.py",
    "LICENSE",
    undefined,
  ]);
  assertEquals(
    languages.map((l) => l.id),
    ["typescript", "markdown", "json", "yaml", "python", "plain-text"],
  );
});

Deno.test("renderedLinesFor rejects a renderer that changes line topology", () => {
  assertEquals(
    renderedLinesFor(plainTextLanguage, "plain", "notes.txt"),
    undefined,
  );
  assertThrows(
    () =>
      renderedLinesFor(
        {
          ...markdownLanguage,
          id: "malformed",
          renderLines: () => [],
        },
        "first\nsecond",
        "notes.md",
      ),
    Error,
    "malformed rendered 0 lines for 2 source lines",
  );
});

Deno.test("renderedLinesFor rejects malformed display lines", () => {
  const malformed = (renderLines: () => Line[]) => ({
    ...markdownLanguage,
    id: "malformed",
    renderLines,
  });
  assertThrows(
    () =>
      renderedLinesFor(
        malformed(() => [{
          text: "first\nsecond",
          spans: [{ col: 0, text: "first\nsecond", cls: "plain" }],
        }]),
        "source",
      ),
    Error,
    "malformed rendered a line break inside display line 1",
  );
  assertThrows(
    () =>
      renderedLinesFor(
        malformed(() => [{
          text: "visible",
          spans: [{ col: 0, text: "different", cls: "plain" }],
        }]),
        "source",
      ),
    Error,
    "malformed rendered spans that do not reconstruct display line 1",
  );
});

const FILE_TEXT = `export function double(n: number): number {
    return n * 2;
}
export const answer = double(21);
`;

const DIFF = `diff --git a/m.ts b/m.ts
--- a/m.ts
+++ b/m.ts
@@ -1,4 +1,4 @@ export function double
 export function double(n: number): number {
     return n * 2;
 }
-export const answer = 42;
+export const answer = double(21);
`;

function tempWorkspace(): {
  root: string;
  ws: DiffWorkspace;
  done: () => void;
} {
  const root = Deno.makeTempDirSync();
  Deno.writeTextFileSync(join(root, "deno.json"), "{}");
  Deno.writeTextFileSync(join(root, "m.ts"), FILE_TEXT);
  return {
    root,
    ws: {
      resolve: (p) => join(root, p),
      read: (a) => {
        try {
          return Deno.readTextFileSync(a);
        } catch {
          return null;
        }
      },
    },
    done: () => Deno.removeSync(root, { recursive: true }),
  };
}

Deno.test("diffSemanticsFor: TypeScript answers over its own files in the diff", () => {
  const { root, ws, done } = tempWorkspace();
  try {
    const model = parseDiff(DIFF)!;
    const { doc, maps } = buildDiffDocument(DIFF, model, ws);

    // TypeScript offers a diff semantic layer and claims m.ts, so the service
    // builds and answers a type query against the workspace.
    const sem = diffSemanticsFor([typeScriptLanguage], DIFF, maps, {
      cwd: root,
    });
    assert(sem, "TypeScript composes a diff service");
    const answer = doc.flatStructure.find((n) => n.name === "answer")!;
    assertEquals(sem!.typeAt(answer.nameOffset!), "number");

    // Languages without a semantic layer contribute none, so a diff of only
    // those resolves to no service.
    assertEquals(
      diffSemanticsFor(
        [
          markdownLanguage,
          jsonLanguage,
          yamlLanguage,
          pythonLanguage,
          plainTextLanguage,
        ],
        DIFF,
        maps,
        { cwd: root },
      ),
      undefined,
    );
  } finally {
    done();
  }
});

Deno.test("typeScriptLanguage exposes both semantic services", () => {
  const { root, ws, done } = tempWorkspace();
  try {
    // The single-document service: a blob yields a (lazy) service.
    const single = typeScriptLanguage.createSemantics!(
      "const n: number = 1;",
      { cwd: root },
    );
    assert(single, "createSemantics returns a service");
    // The diff service: over the workspace file the diff names.
    const model = parseDiff(DIFF)!;
    const { maps } = buildDiffDocument(DIFF, model, ws);
    const diff = typeScriptLanguage.createDiffSemantics!(DIFF, maps, {
      cwd: root,
    });
    assert(diff, "createDiffSemantics returns a service");
  } finally {
    done();
  }
});

Deno.test("typeScriptLanguage identifies edits confined to quoted string contents", () => {
  const highlightLocally = typeScriptLanguage.highlightDiffLineEditLocally!;
  const stringLine = typeScriptLanguage.highlightLines(
    '  "AAHED",',
    "words.ts",
  )[0];
  assert(
    highlightLocally(stringLine, '  "AAHEDS",'),
    "an insertion before the unchanged closing quote stays within one string",
  );
  const contextualBefore = [
    "const value = {",
    '  label: "A", nested: [true],',
    "};",
  ].join("\n");
  const contextualAfter = contextualBefore.replace('"A"', '"A😀"');
  assertEquals(
    highlightLocally(
      typeScriptLanguage.highlightLines(contextualBefore, "object.ts")[1],
      '  label: "A😀", nested: [true],',
    ),
    typeScriptLanguage.highlightLines(contextualAfter, "object.ts")[1],
    "other token classes, bracket depths, and Unicode columns stay unchanged",
  );
  assertEquals(
    highlightLocally(stringLine, '  "AAHED\\S",'),
    null,
    "an escape change can alter how the rest of the line is tokenised",
  );
  const escapedLine = typeScriptLanguage.highlightLines(
    String.raw`const value = "a\"b";`,
    "escaped.ts",
  )[0];
  assertEquals(
    highlightLocally(
      escapedLine,
      String.raw`const value = "ax\"b";`,
    ),
    null,
    "an existing escape can interact with an adjacent edit",
  );

  const templateLine = typeScriptLanguage.highlightLines(
    "const value = `\nbefore\n`;\n",
    "template.ts",
  )[1];
  assertEquals(
    highlightLocally(templateLine, "after"),
    null,
    "template contents retain state from an earlier line",
  );
});

Deno.test("diffSemanticsFor: a language with no matching files is skipped", () => {
  // TypeScript offers a service, but the diff's only file is Markdown, so its
  // root-file set is empty and it contributes nothing.
  const maps: DiffMaps = {
    rootFiles: ["/workspace/README.md"],
    toFile: () => null,
    fromFile: () => null,
  };
  assertEquals(
    diffSemanticsFor([typeScriptLanguage], "diff", maps, { cwd: "/workspace" }),
    undefined,
  );
});
