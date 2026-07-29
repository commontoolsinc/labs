/**
 * Entry point for `cf view`. Reads the input (a file argument or piped stdin),
 * parses it once — as a unified diff when it reads as one, otherwise with the
 * language selected from its filename — then either launches the interactive
 * pager (when stdout is a TTY) or prints the selected source or rendered
 * representation and exits, mirroring how `less`/`bat` behave when their
 * output is redirected.
 * Filename-free compiler output keeps the transformed TypeScript default.
 * Other source uses filename and shebang metadata unless an explicit language
 * selects another language.
 */
import { renderLineColored } from "./highlight.ts";
import { runPager } from "./pager.ts";
import type { Document } from "./model.ts";
import { ViewError } from "./errors.ts";
import { detectDiff, type DiffModel, parseDiff } from "./diff.ts";
import {
  buildDiffDocument,
  realWorkspace,
  type WorkspaceCache,
} from "./diffdoc.ts";
import {
  diffSemanticsFor,
  distinctLanguages,
  type Language,
  languageForFile,
  languageForName,
  languageForSource,
  languageForTransformedOutput,
  languageNames,
  type Semantics,
} from "./languages/language.ts";
import {
  type EditableSource,
  fileSource,
  readonlySource,
} from "./editsource.ts";
import { diffSource } from "./diffedit.ts";
import { findCommitHeaders, realGit } from "./commitmsg.ts";

export { ViewError };

export type ColorWhen = "always" | "auto" | "never";

export interface ViewOptions {
  color: ColorWhen;
  plain: boolean;
  lineNumbers: boolean;
  /** Start in the rendered representation when one is available. */
  rendered?: boolean;
  file?: string;
  /** Select piped source with this stable language identifier. */
  language?: string;
  /** Select piped source as though it had this filename. */
  filename?: string;
  /** Force (true) or suppress (false) diff mode; undefined auto-detects. */
  diff?: boolean;
}

export async function viewMain(options: ViewOptions): Promise<void> {
  const selection = pipedSelection(options);
  const text = await readInput(options.file);
  if (text.trim().length === 0) {
    throw new ViewError(
      options.file
        ? `cf view: "${options.file}" is empty.`
        : "cf view: no input. Pipe transformed TypeScript in, e.g.\n" +
          "  cf check ./pattern.tsx --show-transformed --no-run | cf view\n" +
          "a diff: git diff origin/main | cf view\n" +
          "or pass a file: cf view transformed.ts",
    );
  }

  const { doc, semantics, editSource } = buildView(
    text,
    options.file,
    options.diff,
    selection,
  );
  const stdoutTty = Deno.stdout.isTerminal();
  const interactive = !options.plain && stdoutTty;
  const color = options.color === "always"
    ? true
    : options.color === "never"
    ? false
    : stdoutTty;

  if (interactive) {
    await runPager(
      doc,
      {
        color: true,
        showLineNumbers: options.lineNumbers,
        viewMode: options.rendered ? "rendered" : "source",
      },
      semantics(),
      editSource,
    );
    return;
  }

  const shown = options.rendered ? editSource.render?.(doc) ?? doc : doc;
  printDocument(shown, color, options.lineNumbers);
}

function pipedSelection(options: ViewOptions): SourceSelection {
  validateSourceSelection(
    options.file,
    options.diff,
    options.language !== undefined || options.filename !== undefined,
  );
  if (options.language === undefined) {
    return { fileName: options.filename };
  }
  const language = languageForName(options.language);
  if (!language) {
    throw new ViewError(
      `cf view: unknown language "${options.language}". Available languages: ${
        languageNames().join(", ")
      }`,
    );
  }
  return { language, fileName: options.filename };
}

/** Explicit syntax selection for source received through a pipe. */
export interface SourceSelection {
  readonly language?: Language;
  readonly fileName?: string;
}

function validateSourceSelection(
  file: string | undefined,
  forceDiff: boolean | undefined,
  sourceSelected: boolean,
): void {
  if (!sourceSelected) return;
  if (file !== undefined) {
    throw new ViewError(
      "cf view: --language and --filename cannot be used with a file argument",
    );
  }
  if (forceDiff === true) {
    throw new ViewError(
      "cf view: --diff cannot be combined with --language or --filename",
    );
  }
}

/**
 * Parse the input into a Document and pick the matching semantic service:
 * diff input gets a program over the current workspace files it names; a
 * transformed blob gets the section-based program. Semantics are constructed
 * lazily — only the interactive path needs them.
 *
 * `forceDiff` pins the mode (`--diff` / `--no-diff`). Automatic detection
 * accepts raw unified diffs only when the first non-empty line starts a
 * structurally parseable diff container. Standard Git commit output has its own
 * complete-header check. Exported for tests.
 *
 * `selection` chooses syntax for piped source. Its virtual filename is
 * advisory and does not make the source editable.
 */
export function buildView(
  text: string,
  file?: string,
  forceDiff?: boolean,
  selection: SourceSelection = {},
): {
  doc: Document;
  semantics: () => Semantics | undefined;
  editSource: EditableSource;
} {
  const sourceSelected = selection.language !== undefined ||
    selection.fileName !== undefined;
  validateSourceSelection(file, forceDiff, sourceSelected);
  const detectContent = forceDiff !== false && !sourceSelected;
  const commitOutput = detectContent && looksLikeCommitOutput(text);
  const parsedDiff = forceDiff === true || commitOutput
    ? parseDiff(text)
    : detectContent
    ? detectDiff(text)
    : null;
  const model: DiffModel | null = parsedDiff ??
    (forceDiff === true || commitOutput
      ? {
        files: [],
        lines: text.split("\n").map(() => ({ kind: "other" as const })),
      }
      : null);
  if (model) {
    const ws = realWorkspace(safeCwd());
    // One workspace cache shared by the initial build and every deferred
    // re-parse, so the named files are read and parsed once per session.
    const cache: WorkspaceCache = new Map();
    const { doc, maps, edit } = buildDiffDocument(text, model, ws, cache);
    // The diff's semantic layer comes from the languages the diff touches.
    const languages = distinctLanguages(
      model.files.map((f) => f.newPath ?? f.oldPath),
    );
    const hasRenderedView = model.files.some((diffFile) =>
      [diffFile.oldPath, diffFile.newPath].some((path) =>
        path !== undefined && !!languageForFile(path).renderLines
      )
    );
    return {
      doc,
      semantics: () =>
        diffSemanticsFor(languages, text, maps, { cwd: safeCwd() }),
      // A diff edits the new side of the files it touches, in place. Saving
      // edited `git show` output amends HEAD with those file and message edits.
      editSource: diffSource(
        ws,
        edit,
        cache,
        realGit(safeCwd()),
        hasRenderedView,
      ),
    };
  }
  const fileName = selection.fileName ?? file;
  const transformedOutput = fileName === undefined &&
    looksLikeTransformedOutput(text);
  const language = selection.language ??
    (transformedOutput
      ? languageForTransformedOutput()
      : languageForSource(fileName, text));
  const doc = language.parseDocument(text, fileName);
  return {
    doc,
    semantics: () =>
      language.createSemantics?.(text, { cwd: safeCwd(), fileName }),
    // A real file is editable; a pipe (transformed output, etc.) is not.
    editSource: file ? fileSource(file, language) : readonlySource(
      "This view is of a pipe — there is no underlying file to edit.",
      language,
      fileName,
    ),
  };
}

/** `cf check --show-transformed` starts each output module with this header. */
function looksLikeTransformedOutput(text: string): boolean {
  const lineEnd = text.indexOf("\n");
  const firstLine = (lineEnd < 0 ? text : text.slice(0, lineEnd)).replace(
    /\r$/,
    "",
  );
  const prefix = "// transformed: ";
  return firstLine.startsWith(prefix) &&
    firstLine.slice(prefix.length).trim().length > 0;
}

/** A standard `git show` or `git log` header. Unlike a diff heuristic, this also
 * recognizes commits with no message or textual file hunks. */
function looksLikeCommitOutput(text: string): boolean {
  const lines = text.split("\n").map((line) =>
    line.endsWith("\r") ? line.slice(0, -1) : line
  );
  const first = lines.findIndex((line) => line.trim().length > 0);
  if (first < 0) return false;
  const commits = findCommitHeaders(lines);
  const commit = commits.find((candidate) => candidate.line === first);
  if (!commit) return false;
  if (lines[first].startsWith(`From ${commit.sha} `)) {
    const separator = lines.indexOf("", first + 1);
    if (separator < 0) return false;
    const headers = lines.slice(first + 1, separator);
    return headers.some((line) => /^From: .+<[^<>]*>$/.test(line)) &&
      headers.some((line) => /^Date: .+/.test(line)) &&
      headers.some((line) => /^Subject: .+/.test(line));
  }
  if (!lines[first].startsWith(`commit ${commit.sha}`)) {
    return lines.slice(first + 1).some((line) =>
      line.startsWith("diff --git ")
    );
  }
  const separator = lines.indexOf("", first + 1);
  if (separator < 0) return false;
  const headers = lines.slice(first + 1, separator);
  return headers.some((line) =>
    /^Author:\s+.*<[^<>]*>$/.test(line) ||
    /^author .*<[^<>]*> -?\d+ [+-]\d{4}$/.test(line)
  );
}

function safeCwd(): string {
  try {
    return Deno.cwd();
  } catch {
    return ".";
  }
}

function printDocument(
  doc: Document,
  color: boolean,
  lineNumbers: boolean,
): void {
  const encoder = new TextEncoder();
  // Match the interactive gutter width: enough columns for the largest line
  // number plus one, at least four.
  const gutterWidth = lineNumbers
    ? Math.max(4, String(doc.lines.length).length + 1)
    : 0;
  const out = doc.lines.map((line, i) => {
    const text = renderLineColored(line, color);
    if (gutterWidth === 0) return text;
    return String(i + 1).padStart(gutterWidth - 1) + " " + text;
  });
  Deno.stdout.writeSync(encoder.encode(out.join("\n")));
}

async function readInput(file?: string): Promise<string> {
  if (file) {
    return await Deno.readTextFile(file);
  }
  if (Deno.stdin.isTerminal()) {
    return "";
  }
  const chunks: Uint8Array[] = [];
  const reader = Deno.stdin.readable.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  let total = 0;
  for (const c of chunks) total += c.length;
  const merged = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    merged.set(c, off);
    off += c.length;
  }
  return new TextDecoder().decode(merged);
}
