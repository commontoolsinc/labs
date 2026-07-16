/**
 * Entry point for `cf view`. Reads the input (a file argument or piped stdin),
 * parses it once — as a unified diff when it reads as one, else as transformed
 * TypeScript — then either launches the interactive pager (when stdout is a
 * TTY) or prints the colourised text and exits, mirroring how `less`/`bat`
 * behave when their output is redirected.
 */
import { parseDocument } from "./parse.ts";
import { renderLineColored } from "./highlight.ts";
import { runPager } from "./pager.ts";
import type { Document } from "./model.ts";
import { ViewError } from "./errors.ts";
import { type DiffModel, looksLikeDiff, parseDiff } from "./diff.ts";
import {
  buildDiffDocument,
  realWorkspace,
  type WorkspaceCache,
} from "./diffdoc.ts";
import {
  createDiffSemantics,
  createSemantics,
  type Semantics,
} from "./semantics.ts";
import {
  type EditableSource,
  fileSource,
  readonlySource,
} from "./editsource.ts";
import { diffSource } from "./diffedit.ts";
import { realGit } from "./commitmsg.ts";

export { ViewError };

export type ColorWhen = "always" | "auto" | "never";

export interface ViewOptions {
  color: ColorWhen;
  plain: boolean;
  lineNumbers: boolean;
  file?: string;
  /** Force (true) or suppress (false) diff mode; undefined auto-detects. */
  diff?: boolean;
}

export async function viewMain(options: ViewOptions): Promise<void> {
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
      { color: true, showLineNumbers: options.lineNumbers },
      semantics(),
      editSource,
    );
    return;
  }

  printDocument(doc, color, options.lineNumbers);
}

/**
 * Parse the input into a Document and pick the matching semantic service:
 * diff input gets a program over the current workspace files it names; a
 * transformed blob gets the section-based program. Semantics are constructed
 * lazily — only the interactive path needs them.
 *
 * `forceDiff` pins the mode (`--diff` / `--no-diff`); when auto-detecting, a
 * diff is accepted only if a reasonable share of its lines actually parse as
 * diff content — so a source file that merely EMBEDS a diff (in a string, a
 * test fixture) still views as source. Exported for tests.
 */
export function buildView(
  text: string,
  file?: string,
  forceDiff?: boolean,
): {
  doc: Document;
  semantics: () => Semantics | undefined;
  editSource: EditableSource;
} {
  const tryDiff = forceDiff ?? looksLikeDiff(text);
  const model = tryDiff ? parseDiff(text) : null;
  if (model && (forceDiff || mostlyDiff(model, text))) {
    const ws = realWorkspace(safeCwd());
    // One workspace cache shared by the initial build and every deferred
    // re-parse, so the named files are read and parsed once per session.
    const cache: WorkspaceCache = new Map();
    const { doc, maps, edit } = buildDiffDocument(text, model, ws, cache);
    return {
      doc,
      semantics: () =>
        createDiffSemantics(text, maps, { cwd: safeCwd() }) ?? undefined,
      // A diff edits the new side of the files it touches, in place; a
      // `git show`'s HEAD commit message is editable and amended on save.
      editSource: diffSource(ws, edit, cache, realGit(safeCwd())),
    };
  }
  const doc = parseDocument(text, file ?? "transformed.ts");
  return {
    doc,
    semantics: () =>
      createSemantics(text, { cwd: safeCwd(), fileName: file }) ?? undefined,
    // A real file is editable; a pipe (transformed output, etc.) is not.
    editSource: file ? fileSource(file) : readonlySource(
      "This view is of a pipe — there is no underlying file to edit.",
    ),
  };
}

/** At least a quarter of the non-empty lines parse as diff content. Headers in
 * `git log -p` output are a minority; an embedded diff in a source file is. */
function mostlyDiff(model: DiffModel, text: string): boolean {
  const lines = text.split("\n");
  let nonEmpty = 0;
  let diffLines = 0;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim().length === 0) continue;
    nonEmpty++;
    if (model.lines[i]?.kind !== "other") diffLines++;
  }
  return nonEmpty > 0 && diffLines / nonEmpty >= 0.25;
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
