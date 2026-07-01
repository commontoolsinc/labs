/**
 * Builds a pager {@link Document} from a unified diff, plus the offset maps the
 * semantic layer needs to answer type/definition queries against the CURRENT
 * workspace files the diff names.
 *
 * Rendering keeps the diff text verbatim (colour only). Code lines get full
 * syntax highlighting: a context/addition line whose content matches the
 * workspace file reuses that file's parsed spans (shifted past the marker
 * column); anything else — removals, drifted lines, missing files — falls back
 * to a per-hunk fragment parse, so even the old side reads as code.
 *
 * The structure tree is: file (a `section` node) → hunk → the workspace file's
 * own structure nodes, clamped and remapped into diff coordinates. So WASD and
 * the info card navigate the same patterns/builders/schemas the source view
 * would show, scoped to what the diff touches.
 */
import type {
  Definition,
  Document,
  Line,
  Span,
  StructureNode,
} from "./model.ts";
import { flattenStructure } from "./model.ts";
import type { DiffHunk, DiffModel } from "./diff.ts";
import { computeLineStarts, lineIndexOf, parseDocument } from "./parse.ts";
import { isMarkdownPath } from "./markdown.ts";
import { cpLen } from "./ansi.ts";
import { dirname, isAbsolute, join, relative } from "@std/path";

/** How the diff document reaches the workspace. Injectable for tests. */
export interface DiffWorkspace {
  /** Resolve a diff-relative path to an absolute workspace path, or null. */
  resolve(path: string): string | null;
  /** Read an absolute path's current content, or null. */
  read(absPath: string): string | null;
}

/**
 * The real workspace, rooted at the enclosing git repository (git emits paths
 * relative to the repo root) with the invocation directory as fallback (for
 * `git diff --relative` or plain `diff -u` output). Both resolution and reads
 * are bounded to those roots, so a crafted diff cannot name files outside the
 * workspace.
 */
export function realWorkspace(cwd: string): DiffWorkspace {
  const repoRoot = findRepoRoot(cwd);
  const bases = repoRoot && repoRoot !== cwd ? [repoRoot, cwd] : [cwd];
  // The bound is physical, not lexical: paths are canonicalised before the
  // containment check, so an in-repo symlink pointing outside the workspace
  // cannot smuggle an outside file in.
  const realBases = bases.map((b) => safeRealPath(b) ?? b);
  const within = (abs: string, base: string): boolean => {
    const rel = relative(base, abs);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  };
  const bounded = (abs: string): boolean => {
    if (!bases.some((base) => within(abs, base))) return false; // lexical first
    const real = safeRealPath(abs);
    return real !== null && realBases.some((base) => within(real, base));
  };
  return {
    resolve(path) {
      if (isAbsolute(path)) return null; // diff paths are repo-relative
      for (const base of bases) {
        const abs = join(base, path);
        if (!bounded(abs)) continue; // `..` escapes and symlinks out: blocked
        // bounded() canonicalised abs via realPathSync, so statSync resolves;
        // only the file-vs-directory check remains. read() guards the contents.
        if (Deno.statSync(abs).isFile) return abs;
      }
      return null;
    },
    read(absPath) {
      if (!bounded(absPath)) return null;
      try {
        return Deno.readTextFileSync(absPath);
      } catch {
        return null;
      }
    },
  };
}

function safeRealPath(path: string): string | null {
  try {
    return Deno.realPathSync(path);
  } catch {
    return null;
  }
}

/** Nearest ancestor of `cwd` containing `.git` (a directory or a file). */
function findRepoRoot(cwd: string): string | null {
  let dir = cwd;
  for (let depth = 0; depth < 64; depth++) {
    try {
      Deno.statSync(join(dir, ".git"));
      return dir;
    } catch {
      // keep walking up
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

/**
 * Where a diff's editable lines write back to. A verified new-side diff line
 * (context or addition) maps to a line of its workspace file; editing it (past
 * the marker) and saving rewrites that file line. Removed lines and diff
 * structure are not present.
 */
export interface DiffEdit {
  /** Diff line → the file line it edits, with its marker width (1, or 0 for a
   * trimmed empty context line). */
  readonly lines: ReadonlyMap<
    number,
    { absPath: string; newLine: number; markerLen: number }
  >;
  /** The captured new-side content of each touched file, for splicing edited
   * lines back in on save. */
  readonly fileText: ReadonlyMap<string, string>;
  /** Every hunk, in document order, with the file and new-side range it covers
   * and whether its new side matched the workspace (so the captured content is
   * known to be the hunk's new side). Save matches the edited diff's hunks to
   * these by position — robust to repeated files/ranges in `git log -p` — and
   * rewrites only the verified ones. */
  readonly hunks: readonly DiffHunkInfo[];
}

export interface DiffHunkInfo {
  /** The workspace file the hunk maps to, or null when it resolves to none. */
  readonly absPath: string | null;
  readonly newStart: number;
  readonly newCount: number;
  readonly verified: boolean;
}

/** Maps between diff-text offsets and workspace-file offsets, for semantics. */
export interface DiffMaps {
  /** Absolute paths of the diff's files that exist in the workspace. */
  readonly rootFiles: readonly string[];
  /** Diff offset → (file, file offset), when the offset sits on code that is
   * present (and unchanged) in the current workspace file. */
  toFile(diffOffset: number): { path: string; offset: number } | null;
  /** File offset → diff offset, when that file line is visible in the diff. */
  fromFile(path: string, fileOffset: number): number | null;
}

interface FileMapping {
  readonly absPath: string;
  readonly fileText: string;
  readonly fileLineStarts: number[];
  /** new-file line → diff line, for content-verified ctx/add lines. */
  readonly newToDiff: Map<number, number>;
}

/**
 * Per-session cache of each workspace file's content and parse, keyed by
 * absolute path. The diff is edited, not the workspace, so these are stable: a
 * cache lets the deferred re-parse on every keystroke pause reuse the (costly)
 * TypeScript parses instead of re-reading and re-parsing every named file. It is
 * also consistent with the save map, which captures the same construction-time
 * content.
 */
export type WorkspaceCache = Map<string, LoadedFile>;

interface LoadedFile {
  fileText: string | null;
  fileDoc: Document | null;
  fileLineStarts: number[];
}

function loadFile(
  absPath: string,
  ws: DiffWorkspace,
  cache?: WorkspaceCache,
): LoadedFile {
  const hit = cache?.get(absPath);
  if (hit) return hit;
  const fileText = ws.read(absPath);
  const fileDoc = fileText !== null ? parseDocument(fileText, absPath) : null;
  const fileLineStarts = fileText !== null ? computeLineStarts(fileText) : [];
  const entry: LoadedFile = { fileText, fileDoc, fileLineStarts };
  cache?.set(absPath, entry);
  return entry;
}

export function buildDiffDocument(
  text: string,
  model: DiffModel,
  ws: DiffWorkspace,
  cache?: WorkspaceCache,
): { doc: Document; maps: DiffMaps; edit: DiffEdit } {
  const rawLines = text.split("\n");
  const diffLineStarts = computeLineStarts(text);
  const lines: MutableLine[] = rawLines.map((t) => ({ text: t, spans: [] }));
  const structure: StructureNode[] = [];
  const definitions = new Map<string, Definition[]>();
  const mappings = new Map<string, FileMapping>(); // by abs path
  const hunks: DiffHunkInfo[] = [];

  // Lines not claimed by any file/hunk below default to plain text.
  for (let i = 0; i < rawLines.length; i++) {
    const kind = model.lines[i]?.kind ?? "other";
    if (kind === "other" && rawLines[i].length > 0) {
      lines[i].spans = [{ col: 0, text: rawLines[i], cls: "plain" }];
    }
  }

  for (const file of model.files) {
    const absPath = file.newPath ? ws.resolve(file.newPath) : null;
    const loaded = absPath ? loadFile(absPath, ws, cache) : null;
    const fileText = loaded?.fileText ?? null;
    const fileDoc = loaded?.fileDoc ?? null;
    const fileLineStarts = loaded?.fileLineStarts ?? [];

    let mapping: FileMapping | undefined;
    if (absPath && fileText !== null) {
      mapping = mappings.get(absPath) ?? {
        absPath,
        fileText,
        fileLineStarts,
        newToDiff: new Map(),
      };
      mappings.set(absPath, mapping);
    }

    // --- file header lines -------------------------------------------------
    for (let i = file.headerLine; i <= file.endLine; i++) {
      const kind = model.lines[i]?.kind;
      if (kind !== "meta") continue;
      const t = rawLines[i];
      if (t.length === 0) continue;
      lines[i].spans = [{
        col: 0,
        text: t,
        cls: t.startsWith("diff --git ") ? "sectionHeader" : "diffMeta",
      }];
    }

    const hunkNodes: StructureNode[] = [];
    for (const hunk of file.hunks) {
      hunkNodes.push(buildHunk(hunk, {
        rawLines,
        modelLines: model.lines,
        lines,
        diffLineStarts,
        fileDoc,
        fileText,
        fileLineStarts,
        mapping,
        definitions,
        hunks,
        // A deleted file's new path is /dev/null (absent), so fall back to the
        // old path; otherwise a removed .md reads as TypeScript.
        markdown: isMarkdownPath(file.newPath ?? file.oldPath),
      }));
    }

    // --- the file's section node -------------------------------------------
    const label = file.newPath ?? file.oldPath ?? "(unknown file)";
    const start = diffLineStarts[file.headerLine];
    const end = lineEndOffset(diffLineStarts, text, file.endLine);
    structure.push({
      kind: "section",
      label: `▸ ${label}`,
      name: file.newPath,
      startLine: file.headerLine,
      endLine: file.endLine,
      startCol: 0,
      endCol: cpLen(rawLines[file.endLine] ?? ""),
      startOffset: start,
      endOffset: end,
      depth: 0,
      children: hunkNodes,
    });
  }

  const flatStructure = flattenStructure(structure);

  const doc: Document = {
    text,
    lines: lines as Line[],
    structure,
    flatStructure,
    definitions,
  };
  return {
    doc,
    maps: buildMaps(diffLineStarts, rawLines, mappings),
    edit: buildEdit(rawLines, mappings, hunks),
  };
}

/** Per-diff-line edit targets: each file's verified new-side lines, keyed by
 * diff line, plus that file's captured content for save-time splicing and the
 * verified hunks that save rewrites. */
function buildEdit(
  rawLines: string[],
  mappings: Map<string, FileMapping>,
  hunks: DiffHunkInfo[],
): DiffEdit {
  const lines = new Map<
    number,
    { absPath: string; newLine: number; markerLen: number }
  >();
  const fileText = new Map<string, string>();
  for (const m of mappings.values()) {
    fileText.set(m.absPath, m.fileText);
    for (const [newLine, diffLine] of m.newToDiff) {
      const markerLen = (rawLines[diffLine] ?? "").length === 0 ? 0 : 1;
      lines.set(diffLine, { absPath: m.absPath, newLine, markerLen });
    }
  }
  return { lines, fileText, hunks };
}

// --- hunk rendering + structure ------------------------------------------------

interface MutableLine {
  text: string;
  spans: Span[];
  bg?: "add" | "del";
}

interface HunkCtx {
  rawLines: string[];
  modelLines: DiffModel["lines"];
  lines: MutableLine[];
  diffLineStarts: number[];
  fileDoc: Document | null;
  fileText: string | null;
  fileLineStarts: number[];
  mapping: FileMapping | undefined;
  definitions: Map<string, Definition[]>;
  hunks: DiffHunkInfo[];
  /** The file is Markdown, so fragment-parsed lines are coloured as Markdown. */
  markdown: boolean;
}

function buildHunk(hunk: DiffHunk, ctx: HunkCtx): StructureNode {
  const { rawLines, modelLines, lines, diffLineStarts } = ctx;

  // Header line.
  lines[hunk.headerLine].spans = [{
    col: 0,
    text: rawLines[hunk.headerLine],
    cls: "diffHunk",
  }];

  // Verify the hunk as a whole, the way `git apply` validates context: EVERY
  // context/addition line must match the workspace file at its stated new-side
  // line number. A stale diff (the workspace gained or lost lines above the
  // hunk) can coincidentally match a single shifted line — blank lines, lone
  // braces, duplicated boilerplate — and per-line acceptance would then answer
  // type/definition queries about the wrong occurrence. All-or-nothing keeps
  // the maps honest: an unverified hunk renders via fragments and maps to
  // nothing.
  let verified = ctx.fileDoc !== null;
  for (let i = hunk.headerLine + 1; verified && i <= hunk.endLine; i++) {
    const entry = modelLines[i];
    if (entry?.kind !== "ctx" && entry?.kind !== "add") continue;
    if (fileLineText(ctx, entry.newLine!) !== rawLines[i].slice(1)) {
      verified = false;
    }
  }
  // Record every hunk in document order so save can match the edited diff's
  // hunks to these by position and rewrite only the verified ones.
  ctx.hunks.push({
    absPath: ctx.mapping?.absPath ?? null,
    newStart: hunk.newStart,
    newCount: hunk.newCount,
    verified,
  });

  // Mapping of this hunk's visible new-file lines → diff lines, and lazily-
  // parsed fragments for lines the workspace cannot vouch for.
  const newToDiff = new Map<number, number>();
  const newFragment: { diffLine: number; code: string }[] = [];
  const oldFragment: { diffLine: number; code: string }[] = [];

  for (let i = hunk.headerLine + 1; i <= hunk.endLine; i++) {
    const entry = modelLines[i];
    const t = rawLines[i];
    if (!entry) continue;
    if (entry.kind === "meta") {
      if (t.length > 0) {
        lines[i].spans = [{ col: 0, text: t, cls: "diffMeta" }];
      }
      continue;
    }
    if (entry.kind !== "ctx" && entry.kind !== "add" && entry.kind !== "del") {
      continue;
    }
    const code = t.slice(1);
    if (entry.kind === "add") lines[i].bg = "add";
    if (entry.kind === "del") lines[i].bg = "del";

    if (entry.kind === "del") {
      oldFragment.push({ diffLine: i, code });
      continue; // spans assigned from the old fragment below
    }
    const n = entry.newLine!;
    if (verified && ctx.fileDoc) {
      newToDiff.set(n, i);
      // The global map feeds semantics. Keep the FIRST verified occurrence:
      // `git log -p` repeats a file across commits (newest first), and the
      // newest occurrence is the one the user is reading.
      if (ctx.mapping && !ctx.mapping.newToDiff.has(n)) {
        ctx.mapping.newToDiff.set(n, i);
      }
      lines[i].spans = shiftSpans(markerSpan(t), ctx.fileDoc.lines[n].spans);
    } else {
      newFragment.push({ diffLine: i, code });
    }
  }

  const newParsed = applyFragmentSpans(
    newFragment,
    lines,
    rawLines,
    ctx.markdown,
  );
  applyFragmentSpans(oldFragment, lines, rawLines, ctx.markdown);

  // --- structure ---------------------------------------------------------
  // Verified hunks remap the workspace file's own nodes (precise ranges, live
  // semantics). Unverified hunks — drifted workspace, missing file — still get
  // navigable structure from the fragment parse of their new side: the nodes
  // come from the diff text itself, so navigation always works; only the
  // semantic extras (types, definitions) stay silent there.
  const children: StructureNode[] = [];
  if (ctx.markdown && ctx.fileDoc && newToDiff.size > 0) {
    children.push(
      ...markdownHeadingNodes(
        ctx.fileDoc.flatStructure,
        newToDiff,
        hunk.endLine,
        diffLineStarts,
        rawLines,
      ),
    );
  } else if (ctx.fileDoc && newToDiff.size > 0) {
    for (const root of ctx.fileDoc.structure) {
      children.push(...remapNode(root, 2, null, {
        newToDiff,
        diffLineStarts,
        rawLines,
        sourceLineStarts: ctx.fileLineStarts,
        definitions: ctx.definitions,
      }));
    }
  } else if (newParsed && newFragment.length > 0) {
    // Fragment line i is the i-th ctx/add line of the hunk, in order.
    const fragToDiff = new Map(newFragment.map((f, i) => [i, f.diffLine]));
    if (ctx.markdown) {
      children.push(
        ...markdownHeadingNodes(
          newParsed.flatStructure,
          fragToDiff,
          hunk.endLine,
          diffLineStarts,
          rawLines,
        ),
      );
    } else {
      const fragLineStarts = computeLineStarts(
        newFragment.map((f) => f.code).join("\n"),
      );
      for (const root of newParsed.structure) {
        children.push(...remapNode(root, 2, null, {
          newToDiff: fragToDiff,
          diffLineStarts,
          rawLines,
          sourceLineStarts: fragLineStarts,
          definitions: ctx.definitions,
        }));
      }
    }
  }

  // Tell the user when the workspace could not vouch for this hunk (and the
  // semantic features are therefore off): the note rides the label, visible in
  // the status bar and breadcrumbs.
  const note = ctx.fileDoc === null
    ? "  (no workspace file)"
    : verified
    ? ""
    : "  (workspace differs)";
  const label =
    (hunk.context.length > 0
      ? `@@ ${hunk.context}`
      : `@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount}`) +
    note;
  return {
    kind: "hunk",
    label,
    startLine: hunk.headerLine,
    endLine: hunk.endLine,
    startCol: 0,
    endCol: cpLen(rawLines[hunk.endLine] ?? ""),
    startOffset: diffLineStarts[hunk.headerLine],
    endOffset: diffLineStarts[hunk.endLine] +
      (rawLines[hunk.endLine] ?? "").length,
    depth: 1,
    children,
  };
}

function fileLineText(ctx: HunkCtx, n: number): string | null {
  if (ctx.fileText === null || n >= ctx.fileLineStarts.length) return null;
  const start = ctx.fileLineStarts[n];
  const end = n + 1 < ctx.fileLineStarts.length
    ? ctx.fileLineStarts[n + 1] - 1
    : ctx.fileText.length;
  return ctx.fileText.slice(start, end);
}

function markerSpan(lineText: string): Span {
  const marker = lineText.slice(0, 1);
  return {
    col: 0,
    text: marker,
    cls: marker === "+" ? "diffAdd" : marker === "-" ? "diffDel" : "whitespace",
  };
}

/** Marker span + the code spans shifted one column right past the marker. */
function shiftSpans(marker: Span, spans: readonly Span[]): Span[] {
  const out: Span[] = [marker];
  for (const s of spans) out.push({ ...s, col: s.col + 1 });
  return out;
}

/**
 * Heading nodes for a Markdown hunk's navigation tree. Each heading whose own
 * heading line is shown in the hunk becomes a navigable section, anchored at
 * that line (past the diff marker) and running to the last new-side line before
 * the next shown heading. The general TS structure remap is not used here: it
 * would fold a shown heading into an ancestor whose own heading line is NOT in
 * the diff, so navigation would land on a heading the diff never displays.
 */
function markdownHeadingNodes(
  headings: readonly StructureNode[],
  lineToDiff: Map<number, number>,
  hunkEnd: number,
  diffLineStarts: number[],
  rawLines: string[],
): StructureNode[] {
  const shown: { node: StructureNode; diffLine: number }[] = [];
  for (const node of headings) {
    const diffLine = lineToDiff.get(node.startLine);
    if (diffLine !== undefined) shown.push({ node, diffLine });
  }
  if (shown.length === 0) return [];
  shown.sort((a, b) => a.diffLine - b.diffLine);
  // The diff lines carrying new-side content (heading or body); a section ends
  // at the last of these before the next shown heading, so it never spills onto
  // a trailing removed block or a "\ No newline at end of file" marker (which
  // the TS remap, clamping to visible new-side lines, also excludes).
  const newSide = [...lineToDiff.values()].sort((a, b) => a - b);
  // Depth follows the nesting among the SHOWN headings, walked in document
  // order: the first heading under the hunk is depth 2 and no step jumps more
  // than one level — the pre-order invariant the wasd tree navigation relies
  // on. (A global minimum over the shown set would put a deeper-first window's
  // first heading below depth 2 and strand the sibling/child steps.)
  const stack: { level: number; depth: number }[] = [];
  return shown.map(({ node, diffLine }, i) => {
    while (stack.length > 0 && stack[stack.length - 1].level >= node.depth) {
      stack.pop();
    }
    const depth = stack.length === 0 ? 2 : stack[stack.length - 1].depth + 1;
    stack.push({ level: node.depth, depth });

    const boundary = i + 1 < shown.length ? shown[i + 1].diffLine : hunkEnd + 1;
    let end = diffLine;
    for (const d of newSide) if (d >= diffLine && d < boundary) end = d;

    const endText = rawLines[end] ?? "";
    const startText = rawLines[diffLine] ?? "";
    return {
      kind: "section",
      label: node.label,
      name: node.name,
      startLine: diffLine,
      endLine: end,
      // Past the one-column diff marker.
      startCol: Math.min(1, cpLen(startText)),
      endCol: cpLen(endText),
      startOffset: diffLineStarts[diffLine] + Math.min(1, startText.length),
      endOffset: diffLineStarts[end] + endText.length,
      depth,
      children: [],
    };
  });
}

/**
 * Syntax-highlight diff lines the workspace cannot vouch for by parsing their
 * joined content as one fragment — good token-level classification for the old
 * side and for drifted/new files, without any file on disk. Returns the parsed
 * fragment so its structure tree can be remapped too.
 */
function applyFragmentSpans(
  fragment: { diffLine: number; code: string }[],
  lines: MutableLine[],
  rawLines: string[],
  markdown: boolean,
): Document | null {
  if (fragment.length === 0) return null;
  const parsed = parseDocument(
    fragment.map((f) => f.code).join("\n"),
    markdown ? "fragment.md" : undefined,
  );
  for (let i = 0; i < fragment.length; i++) {
    const { diffLine } = fragment[i];
    const spans = parsed.lines[i]?.spans ?? [];
    lines[diffLine].spans = shiftSpans(markerSpan(rawLines[diffLine]), spans);
  }
  return parsed;
}

// --- structure remapping ---------------------------------------------------

interface RemapCtx {
  /** Source line (file or fragment) → diff line, for visible lines. */
  newToDiff: Map<number, number>;
  diffLineStarts: number[];
  rawLines: string[];
  /** Line starts of the source text the nodes were parsed from. */
  sourceLineStarts: number[];
  definitions: Map<string, Definition[]>;
}

/**
 * Remap a workspace-file structure node into diff coordinates, clamped to the
 * file lines this hunk actually shows. Children recurse. A node whose clamped
 * range coincides with its parent's is folded away — but its CHILDREN are
 * hoisted into the parent, so a hunk interior to deeply nested code still
 * exposes the innermost distinct nodes (and Tab never lands on two
 * identical-looking ones). Returns [] when no line of the node is visible.
 */
function remapNode(
  node: StructureNode,
  depth: number,
  parentRange: { start: number; end: number } | null,
  ctx: RemapCtx,
): StructureNode[] {
  // A diff's structure stays focused on declarations and the like; the generic
  // expression and comment nodes that fill the full-AST tree are skipped, but
  // their meaningful descendants are hoisted into this node's place.
  if (node.kind === "node" || node.kind === "comment") {
    const hoisted: StructureNode[] = [];
    for (const child of node.children) {
      hoisted.push(...remapNode(child, depth, parentRange, ctx));
    }
    return hoisted;
  }

  let firstVisible = -1;
  let lastVisible = -1;
  for (let n = node.startLine; n <= node.endLine; n++) {
    if (ctx.newToDiff.has(n)) {
      if (firstVisible < 0) firstVisible = n;
      lastVisible = n;
    }
  }
  if (firstVisible < 0) return [];

  const startDiffLine = ctx.newToDiff.get(firstVisible)!;
  const endDiffLine = ctx.newToDiff.get(lastVisible)!;
  // Columns: the marker occupies column 0, so code column c becomes c+1. A
  // clamped boundary (the node's true start/end line is not visible) covers
  // the whole shown line instead.
  const startCol = firstVisible === node.startLine ? node.startCol + 1 : 1;
  const endCol = lastVisible === node.endLine
    ? node.endCol + 1
    : cpLen(ctx.rawLines[endDiffLine]);
  const startOffset = ctx.diffLineStarts[startDiffLine] +
    cpToUtf16(ctx.rawLines[startDiffLine], startCol);
  const endOffset = ctx.diffLineStarts[endDiffLine] +
    cpToUtf16(ctx.rawLines[endDiffLine], endCol);

  // Coincidence fold: a node filling its parent's visible range IS the parent
  // as far as the diff shows. Hoist its mapped children in its place (same
  // depth, same parent range) and register its name against the surviving
  // range so `t` lookups still resolve.
  if (
    parentRange && parentRange.start === startOffset &&
    parentRange.end === endOffset
  ) {
    registerDefinition(
      node,
      startDiffLine,
      endDiffLine,
      startOffset,
      endOffset,
      ctx,
    );
    const hoisted: StructureNode[] = [];
    for (const child of node.children) {
      hoisted.push(...remapNode(child, depth, parentRange, ctx));
    }
    return hoisted;
  }

  const nameOffset = remapNameOffset(node, ctx);
  const children: StructureNode[] = [];
  for (const child of node.children) {
    children.push(...remapNode(
      child,
      depth + 1,
      { start: startOffset, end: endOffset },
      ctx,
    ));
  }

  const mapped: StructureNode = {
    kind: node.kind,
    label: node.label,
    name: node.name,
    nameOffset,
    startLine: startDiffLine,
    endLine: endDiffLine,
    startCol,
    endCol,
    startOffset,
    endOffset,
    depth,
    children,
    meta: node.meta,
  };
  registerDefinition(
    node,
    startDiffLine,
    endDiffLine,
    startOffset,
    endOffset,
    ctx,
  );
  return [mapped];
}

function registerDefinition(
  node: StructureNode,
  startLine: number,
  endLine: number,
  startOffset: number,
  endOffset: number,
  ctx: RemapCtx,
): void {
  if (!node.name) return;
  const list = ctx.definitions.get(node.name) ?? [];
  list.push({
    name: node.name,
    kind: node.kind,
    startLine,
    endLine,
    startOffset,
    endOffset,
  });
  ctx.definitions.set(node.name, list);
}

/** The node's declared-name offset in diff coordinates, when visible. */
function remapNameOffset(
  node: StructureNode,
  ctx: RemapCtx,
): number | undefined {
  if (node.nameOffset === undefined) return undefined;
  const n = lineIndexOf(ctx.sourceLineStarts, node.nameOffset);
  const diffLine = ctx.newToDiff.get(n);
  if (diffLine === undefined) return undefined;
  const col = node.nameOffset - ctx.sourceLineStarts[n]; // UTF-16 in the line
  return ctx.diffLineStarts[diffLine] + 1 + col; // +1: the marker is 1 unit
}

// --- offset maps for semantics ----------------------------------------------

function buildMaps(
  diffLineStarts: number[],
  rawLines: string[],
  mappings: Map<string, FileMapping>,
): DiffMaps {
  // diff line → its file mapping + new-file line, for verified lines.
  const byDiffLine = new Map<number, { m: FileMapping; newLine: number }>();
  for (const m of mappings.values()) {
    for (const [newLine, diffLine] of m.newToDiff) {
      byDiffLine.set(diffLine, { m, newLine });
    }
  }
  return {
    rootFiles: [...mappings.keys()],
    toFile(diffOffset) {
      const d = lineIndexOf(diffLineStarts, diffOffset);
      const hit = byDiffLine.get(d);
      if (!hit) return null;
      const col = diffOffset - diffLineStarts[d];
      if (col < 1) return null; // the marker column belongs to the diff
      return {
        path: hit.m.absPath,
        offset: hit.m.fileLineStarts[hit.newLine] + (col - 1),
      };
    },
    fromFile(path, fileOffset) {
      const m = mappings.get(path);
      if (!m) return null;
      const n = lineIndexOf(m.fileLineStarts, fileOffset);
      const diffLine = m.newToDiff.get(n);
      if (diffLine === undefined) return null;
      const col = fileOffset - m.fileLineStarts[n];
      // A trimmed empty context line has no marker character at all.
      const marker = (rawLines[diffLine] ?? "").length === 0 ? 0 : 1;
      return diffLineStarts[diffLine] + marker + col;
    },
  };
}

// --- small helpers -----------------------------------------------------------

/** UTF-16 index of code-point column `col` within `text`. */
function cpToUtf16(text: string, col: number): number {
  let cp = 0;
  let i = 0;
  for (const ch of text) {
    if (cp >= col) break;
    cp++;
    i += ch.length;
  }
  return i;
}

function lineEndOffset(
  lineStarts: number[],
  text: string,
  line: number,
): number {
  if (line + 1 < lineStarts.length) return lineStarts[line + 1] - 1;
  return text.length;
}
