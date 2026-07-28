/**
 * Language selection: `languageForFile` picks a language by extension (and
 * backstops to TypeScript for pipes and unknown files), `distinctLanguages`
 * dedupes the languages a diff touches, and `diffSemanticsFor` composes the diff
 * view's semantic layer from the languages present, scoped to each one's files.
 */
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  diffSemanticsFor,
  distinctLanguages,
  languageForFile,
} from "../lib/view/languages/language.ts";
import { typeScriptLanguage } from "../lib/view/languages/typescript/language.ts";
import { markdownLanguage } from "../lib/view/languages/markdown/language.ts";
import { jsonLanguage } from "../lib/view/languages/json/language.ts";
import { yamlLanguage } from "../lib/view/languages/yaml/language.ts";
import {
  buildDiffDocument,
  type DiffMaps,
  type DiffWorkspace,
} from "../lib/view/diffdoc.ts";
import { parseDiff } from "../lib/view/diff.ts";

Deno.test("languageForFile: extensions resolve, and the rest backstops to TS", () => {
  for (const ts of ["a.ts", "a.tsx", "a.mts", "a.cts", "a.js", "a.jsx"]) {
    assertEquals(languageForFile(ts).id, "typescript", ts);
  }
  assertEquals(languageForFile("README.md").id, "markdown");
  assertEquals(languageForFile("deno.jsonc").id, "json");
  assertEquals(languageForFile("workflow.yml").id, "yaml");
  // No language claims these, so the fallback (TypeScript) resolves them.
  assertEquals(languageForFile("notes.xyz").id, "typescript");
  assertEquals(languageForFile(undefined).id, "typescript");
});

Deno.test("distinctLanguages: dedupes in first-seen order", () => {
  const languages = distinctLanguages([
    "a.ts",
    "b.ts",
    "c.md",
    "d.json",
    "e.yaml",
    undefined,
  ]);
  assertEquals(
    languages.map((l) => l.id),
    ["typescript", "markdown", "json", "yaml"],
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
        [markdownLanguage, jsonLanguage, yamlLanguage],
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
