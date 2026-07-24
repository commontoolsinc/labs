/**
 * The contract every source language plugs into so the `cf view` pager can
 * colour, navigate, edit and (optionally) reason about it. A language is a
 * stateless strategy object: one instance describes TypeScript, one Markdown,
 * one JSON. The pager selects the right one for a file ONCE (see
 * {@link ./registry.ts}) and then dispatches every operation through that
 * object's methods — there is no per-operation branch on the file extension.
 *
 * Per-file mutable state (a warm incremental parse, a language service) is not
 * held on the language; the language is a factory for the small stateful
 * objects that hold it ({@link Highlighter}, {@link Semantics}).
 *
 * The contract lives here, apart from any concrete language, so the neutral core
 * (renderer, pager, diff builder, editor) can depend on it without depending on
 * a specific language.
 */
import type { Definition, Document, Line, StructureNode } from "../model.ts";
import type { DiffMaps } from "../diffdoc.ts";

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
  /** Stable identifier, e.g. `"typescript"`, `"markdown"`, `"json"`. */
  readonly id: string;

  /** Does this language claim `fileName`? The catch-all language returns true
   * for everything (it is the fallback), so more specific languages must be
   * consulted before it — see {@link ./registry.ts}. */
  matches(fileName: string | undefined): boolean;

  /** Parse `text` into the full document model: coloured lines, a structure
   * tree, and a name → definition index. `fileName` is advisory. */
  parseDocument(text: string, fileName?: string): Document;

  /** Colour `text` into rendered lines only — the per-keystroke-safe subset of
   * {@link parseDocument}, with no structure tree or definitions. Used by the
   * non-interactive fast path and the diff fragment renderer. `fileName` is
   * advisory (a language may parse `.ts` and `.tsx` differently). */
  highlightLines(text: string, fileName?: string): Line[];

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
