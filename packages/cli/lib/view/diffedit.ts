/**
 * The editable source for a diff view. A diff edits the new side of the files it
 * touches: context and added lines are editable past their marker, lines can be
 * added (a new line becomes an added line) and removed, and the marker column
 * and the old (removed) side are protected.
 *
 * Re-highlighting on each keystroke rebuilds the diff document from the edited
 * text. The save map (which hunks verified, and each file's captured new-side
 * content) is fixed at construction against the pristine files: an in-flight
 * edit makes the diff stop matching disk, which is exactly why it must not be
 * recomputed from the edited text.
 */
import type { Document, Line, Span } from "./model.ts";
import {
  buildDiffDocument,
  type DiffEdit,
  type DiffWorkspace,
  type WorkspaceCache,
} from "./diffdoc.ts";
import { type DiffHunk, type DiffModel, parseDiff } from "./diff.ts";
import {
  type CommitMessage,
  extractMessage,
  findCommitMessages,
  type GitRunner,
  MESSAGE_INDENT,
  messageAt,
  sameCommit,
} from "./commitmsg.ts";
import { highlightDocument, type Highlighter, parseDocument } from "./parse.ts";
import { highlightMarkdownLines, isMarkdownPath } from "./markdown.ts";
import type {
  EditableSource,
  EditPolicy,
  ExpandResult,
  RevertScope,
} from "./editsource.ts";
import { shortName } from "./editsource.ts";

export function diffSource(
  ws: DiffWorkspace,
  edit: DiffEdit,
  cache?: WorkspaceCache,
  git?: GitRunner,
): EditableSource {
  const files = [...edit.fileText.keys()];
  // The HEAD commit's hash, computed once — the message of that commit (and only
  // it) is editable. Absent when there is no git runner or no repository.
  let headResolved = false;
  let head: string | null = null;
  const headSha = (): string | null => {
    if (!headResolved) {
      headResolved = true;
      head = git?.headSha() ?? null;
    }
    return head;
  };

  // The HEAD commit's message region in the given lines, or null. The regions
  // shift as the diff is edited, so they are re-derived from the current text.
  const editableMessage = (lines: readonly string[]): CommitMessage | null => {
    const h = headSha();
    if (!h) return null;
    for (const m of findCommitMessages(lines)) {
      if (sameCommit(m.sha, h)) return m;
    }
    return null;
  };

  // No file on disk backs this diff (nothing resolved or verified): read-only.
  if (edit.lines.size === 0) {
    return {
      label: null,
      isDiff: true,
      editable: false,
      reason:
        "This diff doesn't match any file on disk, so there is nothing to edit.",
      parse: (text) => reparse(ws, text, cache),
      save: () => "Nothing to save — this diff matches no file on disk.",
    };
  }

  // Save reads the hunks' current new-side file ranges, which expanding context
  // grows, so keep a mutable copy that expand and save share.
  const saveHunks: MutableHunk[] = edit.hunks.map((h) => ({ ...h }));

  // Editability is decided against the current diff structure. Re-parsing the
  // whole buffer on each edit key is wasteful, so memoise the parse and the
  // message scan by the text they came from; the several guard calls within one
  // keystroke reuse them.
  let memoText: string | null = null;
  let memoModel: DiffModel | null = null;
  let memoMessages: readonly CommitMessage[] = [];
  const classify = (
    lines: readonly string[],
  ): { model: DiffModel | null; messages: readonly CommitMessage[] } => {
    const text = lines.join("\n");
    if (text !== memoText) {
      memoText = text;
      memoModel = parseDiff(text);
      memoMessages = findCommitMessages(lines);
    }
    return { model: memoModel, messages: memoMessages };
  };

  const kindOf = (
    lines: readonly string[],
    row: number,
  ): "hunk" | "message" | null => {
    const { model, messages } = classify(lines);
    if (editableStart(model, saveHunks, lines[row] ?? "", row) !== null) {
      return "hunk";
    }
    const h = headSha();
    if (h) {
      const m = messageAt(messages, row);
      if (m && sameCommit(m.sha, h)) return "message";
    }
    return null;
  };

  const policy: EditPolicy = {
    editStart: (lines, row) => {
      const kind = kindOf(lines, row);
      if (kind === "hunk") {
        return editableStart(
          classify(lines).model,
          saveHunks,
          lines[row] ?? "",
          row,
        );
      }
      // A message line is editable past its four-space indent.
      return kind === "message" ? MESSAGE_INDENT.length : null;
    },
    regionKind: kindOf,
    insertPrefix: "+",
    messageIndent: MESSAGE_INDENT,
  };

  return {
    label: files.length === 1 ? shortName(files[0]) : `${files.length} files`,
    isDiff: true,
    editable: true,
    policy,
    parse: (text) => reparse(ws, text, cache),
    // Live highlighting recolours only the lines an edit changes and reuses the
    // seed (buildDiffDocument's colours, including the file/hunk headers and the
    // workspace-file syntax highlighting) for the rest. Cost tracks the edit,
    // not the whole diff, and the unchanged headers never flicker colour. The
    // full parse on pause restores workspace-verified spans across the edit.
    createHighlighter: (text, seed) => createDiffHighlighter(text, seed),
    dirtyLabels: (original, current) => dirtyLabels(original, current),
    revert: (original, current, cursorLine, scope) =>
      revert(original, current, cursorLine, scope),
    expandContext: (current, baseline, cursorLine) =>
      expandContext(ws, cache, saveHunks, current, baseline, cursorLine),
    save: (text) => save(text, edit.fileText, saveHunks),
    pendingAmend: (baseline, current) =>
      pendingAmend(editableMessage, baseline, current),
    amendCommit: (baseline, current) =>
      amendCommit(git, editableMessage, baseline, current),
  };
}

/** The commit whose message a save would amend: the HEAD message region exists
 * and its text differs from the baseline. Null otherwise. */
function pendingAmend(
  editableMessage: (lines: readonly string[]) => CommitMessage | null,
  baseline: string,
  current: string,
): { sha: string; subject: string } | null {
  const curLines = current.split("\n");
  const msg = editableMessage(curLines);
  if (!msg) return null;
  const baseMsg = editableMessage(baseline.split("\n"));
  const newText = extractMessage(curLines, msg);
  if (baseMsg && extractMessage(baseline.split("\n"), baseMsg) === newText) {
    return null; // the message is unchanged
  }
  // The subject is the first non-blank line — git strips leading blanks — so an
  // all-blank message reports an empty subject, which the caller refuses.
  const subject = newText.split("\n").find((l) => l.trim() !== "") ?? "";
  return { sha: msg.sha, subject };
}

/** Amend the HEAD commit's message from the edited text. Re-reads HEAD to guard
 * against it having moved (an external commit) since the diff was shown — the
 * amend rewrites whatever is HEAD, so it must still be the commit the message
 * belongs to. Throws when there is no git runner or no editable message (the
 * caller checks {@link pendingAmend} first, so those are defensive). */
function amendCommit(
  git: GitRunner | undefined,
  editableMessage: (lines: readonly string[]) => CommitMessage | null,
  _baseline: string,
  current: string,
): string {
  const curLines = current.split("\n");
  const msg = editableMessage(curLines);
  if (!git || !msg) throw new Error("No commit message to amend.");
  const live = git.headSha();
  if (!live || !sameCommit(msg.sha, live)) {
    throw new Error(
      "HEAD has moved since this diff was shown; the commit was not amended.",
    );
  }
  return git.amendMessage(extractMessage(curLines, msg));
}

/**
 * Restore the cursor's hunk, the cursor's file, or the whole diff to its
 * original form. The edited and original diffs hold the same files and hunks in
 * the same document order (an edit or a context expansion never adds, removes,
 * or reorders them), so the cursor's file and hunk are matched to the original
 * by that order — which stays correct even when a path repeats across commits
 * (`git log -p`) or a hunk's start line has shifted from a context expansion.
 * The original supplies the replacement lines. Returns the new full text and
 * where to leave the cursor, or null when there is nothing to restore.
 */
function revert(
  original: string,
  current: string,
  cursorLine: number,
  scope: RevertScope,
): { text: string; cursorLine: number } | null {
  if (original === current) return null;
  const baseLines = original.split("\n");
  if (scope === "all") {
    return {
      text: original,
      cursorLine: Math.min(cursorLine, baseLines.length - 1),
    };
  }
  if (scope === "message") {
    return revertMessage(baseLines, current.split("\n"), cursorLine);
  }
  const cur = parseDiff(current);
  const base = parseDiff(original);
  if (!cur || !base) return null;
  const curLines = current.split("\n");
  const fileIdx = cur.files.findIndex((f) =>
    cursorLine >= f.headerLine && cursorLine <= f.endLine
  );
  if (fileIdx < 0) return null;
  const curFile = cur.files[fileIdx];
  const baseFile = base.files[fileIdx];
  if (
    !baseFile ||
    (baseFile.newPath ?? baseFile.oldPath) !==
      (curFile.newPath ?? curFile.oldPath)
  ) {
    return null;
  }

  const splice = (cs: number, ce: number, bs: number, be: number) => ({
    text: [
      ...curLines.slice(0, cs),
      ...baseLines.slice(bs, be + 1),
      ...curLines.slice(ce + 1),
    ].join("\n"),
    cursorLine: cs,
  });

  // Reverting a whole file, or a cursor that sits on the file headers.
  const hunkIdx = scope === "chunk"
    ? curFile.hunks.findIndex((h) =>
      cursorLine >= h.headerLine && cursorLine <= h.endLine
    )
    : -1;
  if (scope === "file" || hunkIdx < 0) {
    return splice(
      curFile.headerLine,
      curFile.endLine,
      baseFile.headerLine,
      baseFile.endLine,
    );
  }
  const curHunk = curFile.hunks[hunkIdx];
  const baseHunk = baseFile.hunks[hunkIdx];
  if (!baseHunk) return null;
  return splice(
    curHunk.headerLine,
    curHunk.endLine,
    baseHunk.headerLine,
    baseHunk.endLine,
  );
}

/** Restore the commit message the cursor is in to its original text. The
 * messages are matched to the original by document order (like files and
 * hunks), so a `git log -p` with several commits reverts the right one. */
function revertMessage(
  baseLines: readonly string[],
  curLines: readonly string[],
  cursorLine: number,
): { text: string; cursorLine: number } | null {
  const curMsgs = findCommitMessages(curLines);
  const idx = curMsgs.findIndex((m) =>
    cursorLine >= m.start && cursorLine <= m.end
  );
  if (idx < 0) return null;
  const cur = curMsgs[idx];
  const base = findCommitMessages(baseLines)[idx];
  if (!base) return null;
  return {
    text: [
      ...curLines.slice(0, cur.start),
      ...baseLines.slice(base.start, base.end + 1),
      ...curLines.slice(cur.end + 1),
    ].join("\n"),
    cursorLine: cur.start,
  };
}

/**
 * Reveal more of the underlying file around the cursor's hunk, at the hunk
 * boundary nearest the cursor. The extra lines are read from the workspace file
 * just above (or below) the hunk's current new-side range and inserted as
 * context, with the hunk header's counts grown to match. The same expansion is
 * applied to `baseline` and to the save map, so revealing context does not
 * register as an edit (dirtiness still reflects only real changes), a later
 * revert keeps it, and a save still writes the correct file range. Returns the
 * new texts and where the cursor moves, or null when there is no backing file or
 * no more context to show.
 */
function expandContext(
  ws: DiffWorkspace,
  cache: WorkspaceCache | undefined,
  hunks: MutableHunk[],
  current: string,
  baseline: string,
  cursorLine: number,
  amount = 10,
): ExpandResult | null {
  const model = parseDiff(current);
  if (!model) return null;
  let index = -1;
  let target: DiffHunk | undefined;
  let targetFile: DiffModel["files"][number] | undefined;
  let gi = 0;
  for (const f of model.files) {
    for (const h of f.hunks) {
      if (cursorLine >= h.headerLine && cursorLine <= h.endLine) {
        index = gi;
        target = h;
        targetFile = f;
      }
      gi++;
    }
  }
  if (!target || !targetFile || targetFile.newPath === undefined) return null;
  const absPath = ws.resolve(targetFile.newPath);
  if (!absPath) return null;
  const content = cache?.get(absPath)?.fileText ?? ws.read(absPath);
  if (content === null) return null;
  const fileLines = content.split("\n");
  const fileLen = fileLines.length > 0 && fileLines[fileLines.length - 1] === ""
    ? fileLines.length - 1
    : fileLines.length;

  // File-range coordinates come from the save map (the original new-file range,
  // which an inserted line does not extend), not the display `@@` counts (which
  // an insert grows past the file range). Insertion positions and the global
  // index come from the parse. Clamp how far context may grow by the
  // neighbouring hunks of the SAME file, so an expansion never overlaps another
  // hunk's file range — that would make save() splice the two ranges into each
  // other (silently dropping edits or duplicating lines) and malform the diff.
  const range = hunks[index];
  const prev = index > 0 && hunks[index - 1].absPath === range.absPath
    ? hunks[index - 1]
    : null;
  const next = index < hunks.length - 1 &&
      hunks[index + 1].absPath === range.absPath
    ? hunks[index + 1]
    : null;
  const prevEnd = prev ? prev.newStart + prev.newCount : 1; // 1-based, free above
  const upAvail = Math.max(0, range.newStart - prevEnd);
  const downFrom = range.newStart - 1 + range.newCount; // 0-based, below it
  const nextStart = next ? next.newStart : fileLen + 1; // 1-based, blocked below
  const downAvail = Math.max(0, nextStart - (downFrom + 1));

  const mid = (target.headerLine + 1 + target.endLine) / 2;
  let up = cursorLine <= mid;
  if (up && upAvail === 0) up = false; // nothing left above
  if (!up && downAvail === 0) up = true; // nothing left below
  const k = Math.min(amount, up ? upAvail : downAvail);
  if (k <= 0) return null;

  const ctx =
    (up
      ? fileLines.slice(range.newStart - 1 - k, range.newStart - 1)
      : fileLines.slice(downFrom, downFrom + k)).map((l) => ` ${l}`);

  // Insert at the parser's hunk boundary (one past its last body line), not a
  // re-scan, so a blank separator below the hunk (git log -p) is not absorbed.
  const baseHunks = parseDiff(baseline)?.files.flatMap((f) => f.hunks) ?? [];
  const baseHunk = baseHunks[index];
  if (!baseHunk) return null;
  const text = applyExpansion(current, index, up, ctx, k, target.endLine + 1);
  const newBaseline = applyExpansion(
    baseline,
    index,
    up,
    ctx,
    k,
    baseHunk.endLine + 1,
  );
  if (text === null || newBaseline === null) return null;
  hunks[index].newCount += k;
  if (up) hunks[index].newStart -= k;
  // The revealed lines land just after the hunk header (up) or just after its
  // last body line (down), both in current-text coordinates.
  const insertedAt = up ? target.headerLine + 1 : target.endLine + 1;
  return {
    text,
    baseline: newBaseline,
    cursorLine: cursorLine + (up ? k : 0),
    insertedAt,
    inserted: k,
  };
}

/** Insert `ctx` context lines at the top (`up`) or just before `bodyEnd` (the
 * line after the hunk's last body line) of the `index`-th hunk in `text`,
 * growing that hunk header's counts by `k`. Null when the hunk or its header
 * cannot be found. */
function applyExpansion(
  text: string,
  index: number,
  up: boolean,
  ctx: string[],
  k: number,
  bodyEnd: number,
): string | null {
  const lines = text.split("\n");
  let gi = -1;
  let h = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^@@ -\d/.test(lines[i])) {
      gi++;
      if (gi === index) {
        h = i;
        break;
      }
    }
  }
  // `index` is a hunk index from parseDiff, whose HUNK_RE is strictly stronger
  // than the `/^@@ -\d/` scan above, so the scan always reaches it; h is set.
  const m = lines[h].match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/);
  if (!m) return null;
  let oldStart = parseInt(m[1], 10);
  let oldCount = m[2] !== undefined ? parseInt(m[2], 10) : 1;
  let newStart = parseInt(m[3], 10);
  let newCount = m[4] !== undefined ? parseInt(m[4], 10) : 1;
  oldCount += k;
  newCount += k;
  if (up) {
    oldStart -= k;
    newStart -= k;
  }
  const header = `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@${
    m[5] ?? ""
  }`;
  const out = up
    ? [...lines.slice(0, h), header, ...ctx, ...lines.slice(h + 1)]
    : [
      ...lines.slice(0, h),
      header,
      ...lines.slice(h + 1, bodyEnd),
      ...ctx,
      ...lines.slice(bodyEnd),
    ];
  return out.join("\n");
}

/**
 * The filenames whose lines differ between the original diff and the edited one.
 * Each file's slice of the diff text (its header through its last hunk line) is
 * compared, matched by path so a line shift in an earlier file does not
 * misattribute a later one. Repeated paths (`git log -p`) are concatenated. A
 * change that touches no file's slice — an edited commit message — names no
 * file, so a save (and the quit prompt) reflects that it writes no files.
 */
function dirtyLabels(original: string, current: string): string[] {
  if (original === current) return [];
  const o = parseDiff(original);
  const c = parseDiff(current);
  if (!o || !c) return [];
  const bodies = (model: DiffModel, text: string): Map<string, string> => {
    const raw = text.split("\n");
    const m = new Map<string, string>();
    for (const f of model.files) {
      const path = f.newPath ?? f.oldPath ?? "(unknown)";
      const body = raw.slice(f.headerLine, f.endLine + 1).join("\n");
      m.set(path, (m.get(path) ?? "") + "\n" + body);
    }
    return m;
  };
  const ob = bodies(o, original);
  const cb = bodies(c, current);
  const out: string[] = [];
  for (const [path, body] of cb) {
    if (body !== ob.get(path)) out.push(shortName(path));
  }
  return out;
}

/**
 * An incremental highlighter for a diff. It recolours only the lines an edit
 * changes (found by a common prefix/suffix of the line arrays) and keeps `seed`
 * — the colours {@link buildDiffDocument} produced for the unedited text — for
 * every line the edit leaves alone. Edited lines are always body lines (headers
 * are not editable), so a per-line marker-aware render is right for them; the
 * headers stay in the unchanged prefix/suffix and never change colour. When no
 * seed is given (it always is, in the session) it renders every line itself.
 */
export function createDiffHighlighter(
  initialText: string,
  seed?: readonly Line[],
): Highlighter {
  let text = initialText;
  let lines: Line[] =
    (seed ?? initialText.split("\n").map((l) => diffLineRender(l))).slice();
  return {
    get lines() {
      return lines;
    },
    update(next: string): readonly Line[] {
      if (next === text) return lines;
      const oldRaw = text.split("\n");
      const newRaw = next.split("\n");
      const minLen = Math.min(oldRaw.length, newRaw.length);
      let p = 0;
      while (p < minLen && oldRaw[p] === newRaw[p]) p++;
      let s = 0;
      while (
        s < minLen - p &&
        oldRaw[oldRaw.length - 1 - s] === newRaw[newRaw.length - 1 - s]
      ) {
        s++;
      }
      const recoloured = newRaw.slice(p, newRaw.length - s).map((l, i) =>
        diffLineRender(l, isMarkdownDiffLine(newRaw, p + i))
      );
      lines = lines.slice(0, p).concat(
        recoloured,
        lines.slice(oldRaw.length - s),
      );
      text = next;
      return lines;
    },
  };
}

/**
 * First editable column of the diff line at `row`, or null when it cannot be
 * edited. A line is editable only when it is a context or added line inside a
 * hunk whose new side matched a file on disk — the only lines a save can write
 * back. A removed line, any structural line, an empty line (no marker to
 * protect), a line in an unverified hunk, and any text outside a hunk (a commit
 * preamble or trailing noise) are all refused. Hunks are matched to the save map
 * by document order, as {@link save} does, so a repeated file in `git log -p`
 * and a context expansion both stay in step.
 */
function editableStart(
  model: DiffModel | null,
  saveHunks: readonly MutableHunk[],
  lineText: string,
  row: number,
): number | null {
  if (!model) return null;
  let gi = 0;
  for (const f of model.files) {
    for (const h of f.hunks) {
      if (row > h.headerLine && row <= h.endLine) {
        const info = saveHunks[gi];
        if (!info?.verified || !info.absPath) return null; // not savable
        const c = lineText[0];
        return c === "+" || c === " " ? 1 : null; // ctx/add past its marker
      }
      gi++;
    }
  }
  return null; // outside every hunk
}

/**
 * Render one edited diff line: the marker keeps its diff colour and row tint and
 * the code after it is highlighted, shifted one column right. Mirrors how the
 * diff document builder paints a line, so a live edit re-colours correctly
 * without rebuilding the whole diff.
 */
function diffLineRender(lineText: string, markdown = false): Line {
  if (lineText.length === 0) return { text: "", spans: [] };
  // A hunk header carries its own colour and its counts change when an edit
  // grows or shrinks the hunk, so colour it the way the full parse does rather
  // than as a body line.
  if (/^@@ /.test(lineText)) {
    return {
      text: lineText,
      spans: [{ col: 0, text: lineText, cls: "diffHunk" }],
    };
  }
  const marker = lineText[0];
  const cls = marker === "+"
    ? "diffAdd"
    : marker === "-"
    ? "diffDel"
    : "whitespace";
  const spans: Span[] = [{ col: 0, text: marker, cls }];
  const code = lineText.slice(1);
  const content = markdown
    ? highlightMarkdownLines(code)[0]?.spans
    : highlightDocument(code)[0]?.spans;
  for (const s of content ?? []) {
    spans.push({ ...s, col: s.col + 1 });
  }
  const bg = marker === "+" ? "add" : marker === "-" ? "del" : undefined;
  return bg ? { text: lineText, spans, bg } : { text: lineText, spans };
}

/** Whether the diff line at `lineIdx` belongs to a Markdown file, by scanning
 * back to the nearest `+++ ` / `diff --git` header. */
function isMarkdownDiffLine(rawLines: string[], lineIdx: number): boolean {
  for (let i = Math.min(lineIdx, rawLines.length - 1); i >= 0; i--) {
    const l = rawLines[i];
    if (l.startsWith("+++ ")) return isMarkdownPath(l.slice(4).split("\t")[0]);
    if (l.startsWith("diff --git ")) return isMarkdownPath(l);
  }
  return false;
}

export const _internal = { editableStart, pendingAmend, amendCommit };

function reparse(
  ws: DiffWorkspace,
  text: string,
  cache?: WorkspaceCache,
): Document {
  const model = parseDiff(text);
  // An edit keeps every line's marker, so the text still parses as a diff; if a
  // pathological edit breaks that, fall back to a plain parse so highlighting
  // still updates.
  return model
    ? buildDiffDocument(text, model, ws, cache).doc
    : parseDocument(text);
}

interface FileSplice {
  newStart: number;
  newCount: number;
  newSide: string[];
}

/** A copy of {@link DiffHunkInfo} the diff source keeps mutable: expanding a
 * hunk's context grows the new-side file range it covers, and save reads the
 * current range. */
interface MutableHunk {
  absPath: string | null;
  newStart: number;
  newCount: number;
  verified: boolean;
}

/**
 * Rebuild each touched file from the edited diff. The edited diff's hunks are
 * matched to the hunks recorded at open, in document order — robust to `git log
 * -p` repeating a file and its ranges across commits — and only the verified
 * ones are written (their captured content is known to be the hunk's new side,
 * so an unverified hunk is never miswritten). For each, the current new side
 * (its context and added lines, markers stripped) replaces the file lines that
 * hunk covered, taken from the recorded `newStart`/`newCount`. Hunks apply high
 * line number first so earlier ranges do not shift.
 *
 * A hunk body is delimited by {@link parseDiff}, which consumes exactly the
 * lines the `@@` counts cover. Reusing that one classification keeps save in
 * step with the parser: a blank line inside the counted body is a context line
 * (an empty content line some tools emit unprefixed), not a terminator, so its
 * file line is carried to the new side instead of being dropped — which would
 * leave fewer new-side lines than `newCount` and truncate the file on save.
 * Inter-hunk text (`git log -p` commit metadata, a trailing separator) falls
 * outside the parsed body, so it is never absorbed.
 */
function save(
  text: string,
  fileText: ReadonlyMap<string, string>,
  hunks: readonly MutableHunk[],
): string {
  const model = parseDiff(text);
  const rawLines = text.split("\n");
  const modelHunks = model?.files.flatMap((f) => f.hunks) ?? [];

  const byFile = new Map<string, FileSplice[]>();
  modelHunks.forEach((hunk, hunkIndex) => {
    const info = hunks[hunkIndex];
    if (!info?.verified || !info.absPath) return;
    const newSide: string[] = [];
    for (let i = hunk.headerLine + 1; i <= hunk.endLine; i++) {
      const kind = model!.lines[i]?.kind;
      // Context and added lines are the new side; the leading marker is stripped
      // (an empty context line carries none, so slicing it stays empty). Removed
      // and `\ No newline` lines belong to the old side only.
      if (kind === "ctx" || kind === "add") newSide.push(rawLines[i].slice(1));
    }
    const list = byFile.get(info.absPath) ?? [];
    list.push({ newStart: info.newStart, newCount: info.newCount, newSide });
    byFile.set(info.absPath, list);
  });

  const out = new Map<string, string[]>();
  for (const [path, splices] of byFile) {
    const base = fileText.get(path);
    if (base === undefined) continue;
    const fileLines = base.split("\n");
    for (const h of [...splices].sort((a, b) => b.newStart - a.newStart)) {
      fileLines.splice(h.newStart - 1, h.newCount, ...h.newSide);
    }
    out.set(path, fileLines);
  }

  let written = 0;
  for (const [path, fileLines] of out) {
    Deno.writeTextFileSync(path, fileLines.join("\n"));
    written++;
  }
  if (written === 0) return "No editable changes to save.";
  return written === 1
    ? `Saved ${shortName([...out.keys()][0])}`
    : `Saved ${written} files`;
}
