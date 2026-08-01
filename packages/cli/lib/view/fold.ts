/**
 * Collapsing whole files in a diff view. Each file the diff touches can be
 * hidden — replaced by a single summary line (its path, its added/removed line
 * counts, and whether it was added, deleted or renamed) — so a large diff can be
 * skimmed a file at a time. This module is pure: it turns the diff text and the
 * set of collapsed files into the per-file ranges and the collapsed line list
 * the session renders; the session owns the fold state and the key commands.
 */
import type { Line, Span, TokenClass } from "./model.ts";
import { parseDiff } from "./diff.ts";

/** One file in the diff, with the collapsed one-line summary to show for it. */
export interface DiffFileRange {
  /** 0-based index in document order — the stable key for the fold set. */
  readonly index: number;
  /** First and last (inclusive) diff-text line of the file (header … last
   * hunk line). */
  readonly headerLine: number;
  readonly endLine: number;
  /** The path used for test-file detection (new side, else old side). */
  readonly path: string;
  readonly isTest: boolean;
  /** The one-line summary shown when the file is collapsed. */
  readonly summary: Line;
}

/** The files a diff touches, each with its line range and collapsed summary. */
export function diffFiles(text: string): DiffFileRange[] {
  const model = parseDiff(text);
  if (!model) return [];
  const raw = text.split("\n");
  return model.files.map((file, index) => {
    let adds = 0;
    let dels = 0;
    for (let i = file.headerLine; i <= file.endLine; i++) {
      const kind = model.lines[i]?.kind;
      if (kind === "add") adds++;
      else if (kind === "del") dels++;
    }
    const binary = anyBinary(raw, file.headerLine, file.endLine);
    const path = file.newPath ?? file.oldPath ?? "(unknown file)";
    return {
      index,
      headerLine: file.headerLine,
      endLine: file.endLine,
      path,
      isTest: isTestPath(path),
      summary: summaryLine({
        oldPath: file.oldPath,
        newPath: file.newPath,
        adds,
        dels,
        binary,
      }),
    };
  });
}

function anyBinary(raw: string[], from: number, to: number): boolean {
  for (let i = from; i <= to && i < raw.length; i++) {
    if (raw[i].startsWith("Binary files") || raw[i].startsWith("GIT binary")) {
      return true;
    }
  }
  return false;
}

interface SummaryInput {
  readonly oldPath?: string;
  readonly newPath?: string;
  readonly adds: number;
  readonly dels: number;
  readonly binary: boolean;
}

/** Build the collapsed summary line: `▸ path  +A −D`, with a `(new)` /
 * `(deleted)` / `(binary)` tag and `old → new` for a rename. */
function summaryLine(f: SummaryInput): Line {
  const spans: Span[] = [];
  let text = "";
  const add = (s: string, cls: TokenClass) => {
    spans.push({ col: cpCount(text), text: s, cls });
    text += s;
  };

  add("▸ ", "punctuation");
  if (f.oldPath && f.newPath && f.oldPath !== f.newPath) {
    add(f.oldPath, "sectionHeader");
    add(" → ", "diffMeta");
    add(f.newPath, "sectionHeader");
  } else {
    add(f.newPath ?? f.oldPath ?? "(unknown file)", "sectionHeader");
  }

  const tag = f.binary
    ? "binary"
    : f.newPath === undefined
    ? "deleted"
    : f.oldPath === undefined
    ? "new"
    : "";
  if (tag) add(`  (${tag})`, "diffMeta");

  if (!f.binary) {
    add("  ", "whitespace");
    add(`+${f.adds}`, "diffAdd");
    add(" ", "whitespace");
    add(`−${f.dels}`, "diffDel");
  }
  return { text, spans };
}

function cpCount(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

// --- the collapsed line list ------------------------------------------------

/**
 * Maps between the full document's lines and the collapsed display: a collapsed
 * file's whole range becomes its single summary line, everything else passes
 * through. Line numbers on either side are 0-based.
 */
export interface FoldPlan {
  /** The lines to render: full lines, with each collapsed file's range replaced
   * by one summary line. */
  readonly displayLines: readonly Line[];
  /** A document line → the display row it appears on (a line inside a collapsed
   * file maps to that file's summary row). */
  docToDisplay(docLine: number): number;
  /** A display row → the document line it stands for (a summary row maps to its
   * file's header line). */
  displayToDoc(displayRow: number): number;
}

/** The identity plan (nothing collapsed): display equals the document. */
export function identityFold(docLines: readonly Line[]): FoldPlan {
  const clampDoc = (n: number) => clamp(n, 0, Math.max(0, docLines.length - 1));
  return {
    displayLines: docLines,
    docToDisplay: clampDoc,
    displayToDoc: clampDoc,
  };
}

export function buildFoldPlan(
  docLines: readonly Line[],
  files: readonly DiffFileRange[],
  collapsed: ReadonlySet<number>,
): FoldPlan {
  const hidden = files.filter((f) => collapsed.has(f.index));
  if (hidden.length === 0) return identityFold(docLines);

  // For each document line: the summary line to emit here (a collapsed file's
  // header line), or "skip" (a collapsed file's inner line), or pass-through.
  const summaryAt = new Map<number, Line>();
  const skip = new Set<number>();
  for (const f of hidden) {
    summaryAt.set(f.headerLine, f.summary);
    for (let i = f.headerLine + 1; i <= f.endLine; i++) skip.add(i);
  }

  const displayLines: Line[] = [];
  const docToDisplay = new Array<number>(docLines.length);
  const displayToDoc: number[] = [];
  // A skipped line points at the summary row emitted for its file's header.
  let lastDisplay = 0;
  for (let i = 0; i < docLines.length; i++) {
    if (skip.has(i)) {
      docToDisplay[i] = lastDisplay;
      continue;
    }
    const row = displayLines.length;
    displayLines.push(summaryAt.get(i) ?? docLines[i]);
    displayToDoc.push(i);
    docToDisplay[i] = row;
    lastDisplay = row;
  }

  // Both arrays are fully populated over their valid index range (every document
  // line sets a display row; every display row records its document line), so a
  // clamped lookup always hits a value.
  const clampDisplay = (n: number) =>
    clamp(n, 0, Math.max(0, displayLines.length - 1));
  const clampDoc = (n: number) => clamp(n, 0, Math.max(0, docLines.length - 1));
  return {
    displayLines,
    docToDisplay: (docLine) => docToDisplay[clampDoc(docLine)],
    displayToDoc: (row) => displayToDoc[clampDisplay(row)],
  };
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

// --- test-file detection ----------------------------------------------------

const TEST_SEGMENTS = new Set([
  "test",
  "tests",
  "__tests__",
  "testdata",
  "fixtures",
  "fixture",
  "mocks",
  "__mocks__",
]);

/** Whether a path names a test or test-support file: a test-ish directory
 * segment, or a basename like `x.test.ts`, `x.spec.js`, `x_test.go`,
 * `test_x.py`, `x.stories.tsx`, `conftest.py`, or `x.golden`. */
export function isTestPath(path: string): boolean {
  const segs = path.split(/[\\/]/);
  if (segs.some((s) => TEST_SEGMENTS.has(s.toLowerCase()))) return true;
  const base = segs[segs.length - 1] ?? "";
  return /\.(test|spec)\./i.test(base) ||
    /(_|-)test\./i.test(base) ||
    /^test(_|-)/i.test(base) ||
    /\.stories\./i.test(base) ||
    base === "conftest.py" ||
    base.endsWith(".golden");
}
