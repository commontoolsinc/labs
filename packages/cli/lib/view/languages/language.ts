/**
 * The contract every source language plugs into so the `cf view` pager can
 * colour, navigate, edit and (optionally) reason about it, plus selecting the
 * right language for a file. A language is a stateless strategy object: one
 * instance describes each supported syntax, and plain text handles input that
 * has no recognized filename. The pager selects the right one for a file ONCE
 * (via {@link languageForFile}) and then dispatches every operation through
 * that object's methods — there is no per-operation branch on the file
 * extension.
 *
 * Per-file mutable state (a warm incremental parse, a language service) is not
 * held on the language; the language is a factory for the small stateful
 * objects that hold it ({@link Highlighter}, {@link Semantics}).
 *
 * A neutral core file (renderer, pager, diff builder, editor) that needs only
 * the contract imports its types with `import type`, which is erased, so it
 * does not depend on any concrete language at run time; only the selection
 * functions below pull the concrete languages in.
 */
import type { Definition, Document, Line, StructureNode } from "../model.ts";
import type { DiffMaps } from "../diffdoc.ts";
import { typeScriptLanguage } from "./typescript/language.ts";
import { markdownLanguage } from "./markdown/language.ts";
import { jsonLanguage } from "./json/language.ts";
import { yamlLanguage } from "./yaml/language.ts";
import { pythonLanguage } from "./python/language.ts";
import { plainTextLanguage } from "./plain-text/language.ts";

/**
 * Live syntax highlighting that re-highlights only the region an edit touches,
 * so the cost tracks the size of each edit rather than the whole document.
 */
export interface Highlighter {
  /** The current highlighted lines. */
  readonly lines: readonly Line[];
  /** Apply the new full text and return the updated lines. */
  update(text: string): readonly Line[];
}

/** A resolved definition site for a referenced symbol (jump-to-definition). */
export interface DefTarget {
  readonly name: string;
  /** Offset within the same document, when the definition is in-document. */
  readonly blobOffset?: number;
  /** Real file path, when the definition is in a file outside the document. */
  readonly filePath?: string;
  /** Character offset within `filePath`. */
  readonly fileOffset?: number;
  /** 0-based line of the definition (document line in-document, file otherwise). */
  readonly line: number;
  /** 0-based display column of the definition. */
  readonly col?: number;
  /** A trimmed one-line preview of the definition site. */
  readonly preview: string;
}

/**
 * The optional semantic layer a language may provide: "what type is this?" and
 * "where is this defined?", answered against the real workspace. Every query is
 * best-effort and degrades to `null`/empty rather than throwing.
 */
export interface Semantics {
  /** The inferred type at a source offset, or `null` when not knowable. */
  typeAt(offset: number): string | null;
  /**
   * Where the symbol at a source offset is defined. In-document definitions
   * carry a `blobOffset`; definitions in real files carry a `filePath`. Empty
   * when nothing resolves.
   */
  definitionOf(offset: number): DefTarget[];
  /** Read and colour an external file (within the workspace) so the pager can
   * show a definition that lives outside the document. Null when unreadable. */
  fileLines(filePath: string): readonly Line[] | null;
  /** Build the backing program now (off the interactive path), so the first
   * real query does not pay the one-time cost. Safe to call repeatedly. */
  prewarm(): void;
}

/** Options a language needs to build its semantic layer. */
export interface SemanticsOptions {
  /** Working directory, for discovering the workspace / import map. */
  cwd: string;
  /** Name for the implicit single section when the text has no headers. */
  fileName?: string;
}

/**
 * Everything a language needs to project a file's own structure tree into the
 * coordinates of a single diff hunk. `doc` is the parsed source the nodes come
 * from — the current workspace file for a verified hunk, or the hunk's own
 * fragment parse otherwise — and `lineToDiff` maps each of that source's line
 * numbers to the diff line that shows it.
 */
export interface HunkStructureContext {
  readonly doc: Document;
  /** Source line (file or fragment) → diff line, for the lines the hunk shows. */
  readonly lineToDiff: Map<number, number>;
  /** Line starts of the source text `doc` was parsed from. */
  readonly sourceLineStarts: number[];
  /** Last diff line of the hunk (its extent). */
  readonly hunkEnd: number;
  readonly diffLineStarts: number[];
  readonly rawLines: string[];
  /** Name → declaration index the remap contributes to (for `t` peeks). */
  readonly definitions: Map<string, Definition[]>;
}

/**
 * A source language the pager can render and navigate. Selection asks each
 * language {@link matches} once per file; all later work is method dispatch.
 */
export interface Language {
  /** Stable identifier, such as `"typescript"`, `"markdown"`, `"json"`,
   * `"yaml"`, `"python"`, or `"plain-text"`. */
  readonly id: string;

  /** Does this language claim `fileName`? Consulted in order by {@link
   * languageForFile}. */
  matches(fileName: string | undefined): boolean;

  /** Parse `text` into the full document model: coloured lines, a structure
   * tree, and a name → definition index. `fileName` is advisory. */
  parseDocument(text: string, fileName?: string): Document;

  /** Colour `text` into rendered lines only — the per-keystroke-safe subset of
   * {@link parseDocument}, with no structure tree or definitions. Used by the
   * non-interactive fast path and the diff fragment renderer. `fileName` is
   * advisory (a language may parse `.ts` and `.tsx` differently). */
  highlightLines(text: string, fileName?: string): Line[];

  /**
   * Format `text` as the language's rendered representation. The result keeps
   * one display line for every source line, including blank display lines for
   * source-only delimiters. That shared line topology keeps line numbers,
   * structure ranges, diff markers, expansion, and source editing aligned. A
   * line that omits meaningful source content sets `renderedSourceHidden` so a
   * diff can retain its source form when that content changes.
   */
  renderLines?(text: string, fileName?: string): Line[];

  /**
   * Rendering needs the complete file because syntax before a fragment can
   * determine how the fragment is interpreted. A contextless diff fragment
   * stays in source form when this is true.
   */
  readonly renderNeedsCompleteFile?: boolean;

  /** Whether live diff edits need complete-file highlighting because an earlier
   * line can determine how later lines are coloured. */
  readonly highlightFullFileOnDiffEdit?: boolean;

  /** Highlight one source-line edit from its previous complete-file colours, or
   * return null when the edit can affect syntax outside one token. */
  highlightDiffLineEditLocally?(before: Line, after: string): Line | null;

  /** An incremental highlighter seeded with `text`, for live editing.
   * `fileName` is advisory, as for {@link highlightLines}. */
  createHighlighter(text: string, fileName?: string): Highlighter;

  /** Project `ctx.doc`'s structure tree into one diff hunk's coordinates. Also
   * populates `ctx.definitions` with the surviving nodes' declared names, so a
   * peek resolves against the diff. */
  hunkStructure(ctx: HunkStructureContext): StructureNode[];

  /** Build a semantic service over a single document/blob, or return undefined
   * when this language has no semantic layer. */
  createSemantics?(
    text: string,
    options: SemanticsOptions,
  ): Semantics | undefined;

  /** Build a semantic service for a diff view — queries map through
   * {@link DiffMaps} to the current workspace files — or undefined when this
   * language has no semantic layer. */
  createDiffSemantics?(
    diffText: string,
    maps: DiffMaps,
    options: SemanticsOptions,
  ): Semantics | undefined;
}

/** Render through a language and enforce the shared source-line topology. */
export function renderedLinesFor(
  language: Language,
  text: string,
  fileName?: string,
): Line[] | undefined {
  if (!language.renderLines) return undefined;
  const lines = language.renderLines(text, fileName);
  const sourceLineCount = text.split("\n").length;
  if (lines.length !== sourceLineCount) {
    throw new Error(
      `${language.id} rendered ${lines.length} lines for ${sourceLineCount} source lines`,
    );
  }
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (line.text.includes("\n")) {
      throw new Error(
        `${language.id} rendered a line break inside display line ${index + 1}`,
      );
    }
    if (line.spans.map((span) => span.text).join("") !== line.text) {
      throw new Error(
        `${language.id} rendered spans that do not reconstruct display line ${
          index + 1
        }`,
      );
    }
  }
  return lines;
}

// --- selection ---------------------------------------------------------------

/**
 * Every language the pager knows, most specific first, built on first use.
 * Plain text comes last because it claims every named file left after the
 * syntax-specific languages. The fallback below also uses it when no filename
 * exists.
 *
 * The list is lazy so this module's top level never reads the concrete language
 * singletons: they and this module form an import cycle (a language's semantic
 * layer resolves external files back through {@link languageForFile}), and
 * building the array eagerly would read a singleton that a cycle-first load had
 * not yet initialised. By first use every module has finished evaluating.
 */
let languages: readonly Language[] | undefined;
function allLanguages(): readonly Language[] {
  return languages ??= [
    typeScriptLanguage,
    markdownLanguage,
    jsonLanguage,
    yamlLanguage,
    pythonLanguage,
    plainTextLanguage,
  ];
}

/** The language for `fileName` — the first that claims it. Plain text handles
 * unknown named files and input without a filename. */
export function languageForFile(fileName: string | undefined): Language {
  for (const language of allLanguages()) {
    if (language.matches(fileName)) return language;
  }
  return plainTextLanguage;
}

/** Look up a language by its stable identifier for an explicit override. */
export function languageForId(id: string): Language | undefined {
  return allLanguages().find((language) => language.id === id);
}

/** Stable identifiers accepted by an explicit language override. */
export function languageIds(): string[] {
  return allLanguages().map((language) => language.id);
}

/** The TypeScript default for filename-free `cf check --show-transformed`
 * output. The caller checks the compiler's module header before selecting it. */
export function languageForTransformedOutput(): Language {
  return typeScriptLanguage;
}

/** The distinct languages a set of files resolves to, in first-seen order. */
export function distinctLanguages(
  fileNames: readonly (string | undefined)[],
): Language[] {
  const seen = new Set<string>();
  const out: Language[] = [];
  for (const name of fileNames) {
    const language = languageForFile(name);
    if (!seen.has(language.id)) {
      seen.add(language.id);
      out.push(language);
    }
  }
  return out;
}

/**
 * The semantic service for a diff view, from the languages the diff touches. A
 * diff spans potentially many files of different languages; the service is the
 * first language present that offers one, scoped to just its own files (so a
 * TypeScript program is not seeded with the diff's non-TypeScript files). Only
 * TypeScript offers one today, so this resolves to it whenever the diff includes
 * a TypeScript file and to nothing otherwise. When a second semantic language
 * appears this becomes a per-file composite; the per-language slot the pager
 * dispatches through is already here.
 */
export function diffSemanticsFor(
  languages: readonly Language[],
  diffText: string,
  maps: DiffMaps,
  options: SemanticsOptions,
): Semantics | undefined {
  for (const language of languages) {
    if (!language.createDiffSemantics) continue;
    const rootFiles = maps.rootFiles.filter((path) =>
      languageForFile(path) === language
    );
    if (rootFiles.length === 0) continue;
    const semantics = language.createDiffSemantics(
      diffText,
      { ...maps, rootFiles },
      options,
    );
    if (semantics) return semantics;
  }
  return undefined;
}
