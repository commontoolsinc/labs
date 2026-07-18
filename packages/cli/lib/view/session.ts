/**
 * The pager's state machine, with no terminal I/O. {@link Session} holds the
 * scroll/selection/search/overlay state and turns {@link Key} events into state
 * changes; {@link Session.view} projects that state into a {@link ViewState} for
 * the renderer. `pager.ts` drives it against a real TTY, but it is fully
 * exercisable from tests by feeding keys and inspecting `view()`.
 */
import type { Document, Line, StructureNode, TokenClass } from "./model.ts";
import type { Key } from "./keys.ts";
import {
  type DialogButton,
  type DialogState,
  type KeyHint,
  type Match,
  overlayBox,
  type OverlayState,
  type ViewState,
} from "./render.ts";
import {
  clamp,
  findMatches,
  frameTop,
  maxTop,
  nextMatchIndex,
  nodeAtLine,
  scrollToAnchor,
  treeChild,
  treeNextSibling,
  treeParent,
  treePreOrderNext,
  treePreOrderPrev,
  treePrevSibling,
} from "./actions.ts";
import { buildPeekCard, type CardTarget } from "./card.ts";
import {
  DISPLAY_MODES,
  displayColumnOf,
  type DisplayMode,
  displayModeLabel,
  hasNonPrintable,
} from "./display.ts";
import {
  buildFoldPlan,
  type DiffFileRange,
  diffFiles,
  type FoldPlan,
  identityFold,
} from "./fold.ts";
import { parseDiff } from "./diff.ts";
import { findCommitMessages } from "./commitmsg.ts";
import type { Semantics } from "./semantics.ts";
import { EditBuffer } from "./editbuffer.ts";
import type {
  EditableSource,
  ExpandResult,
  HunkRoom,
  RevertScope,
} from "./editsource.ts";
import type { Highlighter } from "./parse.ts";
import type { DirEntry, FileGateway } from "./filegateway.ts";

export interface SessionOptions {
  color: boolean;
  showLineNumbers: boolean;
}

type Mode =
  | "normal"
  | "search"
  | "deflookup"
  | "savePrompt"
  | "amendPrompt"
  | "revertPrompt"
  | "filePicker";

/**
 * Overlay content. A peek carries both an info card and the verbatim source and
 * can toggle between them; the help overlay carries only `info`. The card's
 * cross-reference lines are selectable {@link CardTarget}s that jump the main
 * view to a definition or use.
 */
interface PeekOverlay {
  title: string;
  info: readonly Line[];
  source?: readonly Line[];
  mode: "info" | "source";
  targets: readonly CardTarget[];
  /** Index into `targets` of the highlighted reference, or -1. */
  cardSel: number;
  /** The node this card describes (its subject), for `z` to reveal. */
  node?: StructureNode;
  /** Footer for overlays without a toggle (e.g. help). */
  staticFooter?: string;
  /** The `info` lines are verbatim source (a definition peek, an opened file),
   * not a structured card, so the overlay is drawn as a blue editor window even
   * in "info" mode. */
  infoIsSource?: boolean;
}

const HORIZONTAL_STEP = 8;

// Messages shown when a diff's edit policy refuses an edit.
const NOT_EDITABLE_MSG =
  "This line isn't editable (a removed line or diff structure).";
const MARKER_MSG = "The diff marker column isn't editable.";
const MULTILINE_MSG =
  "Pasting or killing across lines isn't supported while editing a diff.";
const JOIN_MSG =
  "To remove a line in a diff, press Backspace at the start of it.";

/** What the line-number gutter shows: nothing, the position in the piped input
 * (the diff/document line), or the line of the underlying file (a diff line's
 * new-file line) or commit message. */
type LineNumberMode = "off" | "input" | "file";

export class Session {
  private currentDoc: Document;
  private color: boolean;
  private lineNumberMode: LineNumberMode = "off";
  /** How non-printable characters are shown; edit mode forces the first mode. */
  private displayMode: DisplayMode = DISPLAY_MODES[0];
  /** Indices (document order) of the diff files collapsed to a summary line.
   * Cleared when the text cursor is revealed, since hidden lines cannot be
   * edited. `this.top` is a display row while any file is collapsed. */
  private collapsed = new Set<number>();
  /** Bumped whenever `collapsed` changes, to invalidate the fold-plan cache. */
  private foldVersion = 0;
  private foldFileCache?: { doc: Document; files: DiffFileRange[] };
  private foldPlanCache?: { doc: Document; version: number; plan: FoldPlan };
  private nonPrintCache?: { doc: Document; value: boolean };
  private fileLineCache?: { doc: Document; value: (number | null)[] | null };

  width: number;
  height: number;
  top = 0;
  left = 0;
  private selectedIndex: number | null = null;
  private query = "";
  private matches: Match[] = [];
  private currentMatch = 0;
  /** Where an edit-mode search (Ctrl-S) began, so its focused match is the
   * first at or after the cursor and Enter lands the cursor there. Null for a
   * normal-mode `/` search. */
  private searchAnchor: { row: number; col: number } | null = null;
  private message = "";
  private mode: Mode = "normal";
  private input = "";
  private overlay: PeekOverlay | null = null;
  private overlayScroll = 0;
  /** The overlays followed to reach the current one, so Esc walks back through
   * the chain of cards and file peeks. Empty when the current overlay is the
   * first one opened from the main view. */
  private overlayStack: Array<{ overlay: PeekOverlay; scroll: number }> = [];
  private semantics?: Semantics;
  quit = false;
  /** An edit patched only the changed lines for speed; a full re-parse (for
   * structure, cross-references, and multi-line token colours) is owed. The
   * driver runs it on a short idle, so typing stays responsive. */
  needsReparse = false;
  /** What the last key revealed (Ctrl-L in pager mode), for the driver to walk
   * the lines in a few at a time with {@link revealFrame}: the display row they
   * start at, how many there are, and whether they came from above the hunk (so
   * the viewport holds still) or below it (so it slides as they land). The next
   * key clears it. */
  pendingReveal: { row: number; count: number; up: boolean } | null = null;
  /** A prompt button was just activated. Holds the frame that shows it pushed —
   * the dialog with that button drawn mid-press — so the driver can play the
   * press for a moment before the action's result appears. The next key clears
   * it. */
  pendingPush: { doc: Document; view: ViewState } | null = null;
  /** The last key set a message that takes itself away again rather than sitting
   * in the bar — Ctrl-L pressed where it is not offered, which changed nothing
   * else. The driver leaves it up for a moment and then calls
   * {@link expireMessage}; the next key takes it away too. */
  transientMessage = false;
  /** How much context each hunk can reveal, cached against the document. */
  private roomCache?: { doc: Document; room: ReadonlyMap<number, HunkRoom> };

  // --- editing ---
  private source?: EditableSource;
  private buffer?: EditBuffer;
  /** Incremental highlighter for the current buffer, created lazily on the first
   * edit and discarded (re-baselined) on each deferred re-parse and file swap. */
  private highlighter?: Highlighter;
  /** Row of the added line a context-line split produced, so undoing that edit
   * collapses the pair back — even after moving the cursor away and back — while
   * editing an author-written -/+ pair to match does not. Overwritten by the
   * next split, cleared on a collapse or when the buffer text is replaced. */
  private splitRow: number | null = null;
  private cursorOn = false;
  /** Pending C-x prefix (Emacs chord), reset by the next key. */
  private chord: "ctrl-x" | null = null;
  /** Which button the active prompt's Tab focus rests on — an index into its
   * button row. Space and Enter activate it; it is reset to the default button
   * each time a prompt opens. */
  private dialogFocus = 0;
  /** What the active save prompt does on confirm. */
  private savePromptThen: "quit" | null = null;
  /** Set once the user confirms amending the commit message, so the save that
   * follows goes ahead instead of prompting again. */
  private amendConfirmed = false;
  /** Filenames a save would write, computed when the quit prompt opens and
   * listed above it. */
  private editedFiles: string[] = [];

  // --- file picker (C-x C-f) ---
  private readonly files?: FileGateway;
  private pickerDir = "";
  private pickerFilter = "";
  private pickerEntries: DirEntry[] = [];
  private pickerSel = 0;

  constructor(
    doc: Document,
    options: SessionOptions,
    size: { width: number; height: number },
    semantics?: Semantics,
    source?: EditableSource,
    files?: FileGateway,
  ) {
    this.currentDoc = doc;
    this.color = options.color;
    this.lineNumberMode = options.showLineNumbers ? "input" : "off";
    this.width = size.width;
    this.height = size.height;
    this.semantics = semantics;
    this.source = source;
    this.files = files;
    // The edit buffer mirrors the document text; for an editable file the two
    // stay in lock-step (the document is a re-parse of the buffer).
    if (source) this.buffer = new EditBuffer(doc.text);
  }

  get doc(): Document {
    return this.currentDoc;
  }

  // --- file folding ----------------------------------------------------------

  /** The diff's files (with collapsed summaries), or [] for a non-diff view.
   * Cached against the current document. */
  private foldFiles(): DiffFileRange[] {
    if (!this.source?.isDiff) return []; // only a diff has foldable files
    if (this.foldFileCache?.doc !== this.currentDoc) {
      this.foldFileCache = {
        doc: this.currentDoc,
        files: diffFiles(this.currentDoc.text),
      };
    }
    return this.foldFileCache.files;
  }

  /** Whether the document holds any non-printable character, so cycling the
   * display mode would change what is shown. Cached against the document. */
  private hasNonPrintables(): boolean {
    if (this.nonPrintCache?.doc !== this.currentDoc) {
      this.nonPrintCache = {
        doc: this.currentDoc,
        value: this.currentDoc.lines.some((l) => hasNonPrintable(l.text)),
      };
    }
    return this.nonPrintCache.value;
  }

  /** The current collapse plan: the display line list and the maps between
   * document lines and display rows. The identity plan when nothing is hidden. */
  private foldPlan(): FoldPlan {
    if (this.collapsed.size === 0) return identityFold(this.currentDoc.lines);
    if (
      this.foldPlanCache?.doc !== this.currentDoc ||
      this.foldPlanCache.version !== this.foldVersion
    ) {
      this.foldPlanCache = {
        doc: this.currentDoc,
        version: this.foldVersion,
        plan: buildFoldPlan(
          this.currentDoc.lines,
          this.foldFiles(),
          this.collapsed,
        ),
      };
    }
    return this.foldPlanCache.plan;
  }

  /** The document as rendered: full lines, with each collapsed file replaced by
   * its one-line summary. The renderer and cursor placement use this. */
  displayDoc(): Document {
    if (this.collapsed.size === 0) return this.currentDoc;
    return { ...this.currentDoc, lines: this.foldPlan().displayLines };
  }

  /** Number of display rows (fewer than document lines when files are hidden). */
  private displayCount(): number {
    return this.foldPlan().displayLines.length;
  }

  /** A frame part way through the last reveal: the finished document with only
   * the first `shown` of the revealed lines in it, and a viewport holding the
   * same line still as the finished frame will. `shown` of `count` is the
   * finished frame; 0 is the picture the reveal started from. Null when the last
   * key revealed nothing. */
  revealFrame(shown: number): { doc: Document; view: ViewState } | null {
    const rev = this.pendingReveal;
    if (!rev) return null;
    const waiting = rev.count - clamp(shown, 0, rev.count);
    // The lines still to come are the ones furthest from the hunk, so what is on
    // screen is always a run of the file that meets the hunk's edge rather than
    // a jump across the lines that have not arrived.
    const from = rev.up ? rev.row : rev.row + rev.count - waiting;
    const to = from + waiting;
    // Rows past the ones still to come sit `waiting` lower in the finished
    // document than in this frame; rows before them are in the same place.
    const back = (n: number) => n >= to ? n - waiting : n;
    const drop = <T>(xs: readonly T[]) => [
      ...xs.slice(0, from),
      ...xs.slice(to),
    ];
    const doc = this.displayDoc();
    const view = this.view();
    const sel = view.selected;
    return {
      doc: { ...doc, lines: drop(doc.lines) },
      view: {
        ...view,
        top: rev.up ? view.top : Math.max(0, view.top - waiting),
        lineNumbers: view.lineNumbers
          ? drop(view.lineNumbers)
          : view.lineNumbers,
        selected: sel
          ? {
            ...sel,
            startLine: back(sel.startLine),
            endLine: back(sel.endLine),
          }
          : null,
        // A match on a line that has not landed yet has nowhere to be drawn.
        matches: view.matches
          ? view.matches.filter((m) => m.line < from || m.line >= to)
            .map((m) => ({ ...m, line: back(m.line) }))
          : null,
      },
    };
  }

  /** A document line → its display row (a hidden line maps to its summary row). */
  private toDisplay(docLine: number): number {
    return this.foldPlan().docToDisplay(docLine);
  }

  /** A display row → the document line it stands for. */
  private toDoc(displayRow: number): number {
    return this.foldPlan().displayToDoc(displayRow);
  }

  /** The selected node with its line range mapped into display rows (a node in a
   * collapsed file collapses onto that file's summary row). */
  private displaySelected(): StructureNode | null {
    const node = this.selectedNode();
    if (!node || this.collapsed.size === 0) return node;
    return {
      ...node,
      startLine: this.toDisplay(node.startLine),
      endLine: this.toDisplay(node.endLine),
    };
  }

  /** The search matches with their line mapped into display rows. */
  private displayMatches(): Match[] {
    if (this.collapsed.size === 0) return this.matches;
    return this.matches.map((m) => ({ ...m, line: this.toDisplay(m.line) }));
  }

  /** The file currently in view: the diff file or transformed-output section
   * under the viewport (or the cursor, when editing), else the single file the
   * view is of, else null (a bare pipe). */
  private currentFile(): string | null {
    const line = this.cursorOn && this.buffer
      ? this.buffer.row
      : this.toDoc(this.top);
    // The innermost file/section node whose range holds the line (diff file
    // nodes and `// transformed:` blocks are both `section` kind).
    let section: StructureNode | null = null;
    for (const n of this.doc.flatStructure) {
      if (n.kind === "section" && line >= n.startLine && line <= n.endLine) {
        section = n;
      }
    }
    if (section) return section.name ?? section.label.replace(/^[▸▾]\s*/, "");
    return this.source?.label ?? null;
  }

  private get maxLineLen(): number {
    let m = 0;
    for (const l of this.currentDoc.lines) m = Math.max(m, l.text.length);
    return m;
  }

  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    this.clampScroll();
  }

  view(): ViewState {
    const o = this.overlay;
    const ov: OverlayState | null = this.mode === "filePicker"
      ? this.pickerOverlay()
      : o
      ? {
        title: o.title,
        lines: this.activeOverlayLines(o),
        scroll: this.overlayScroll,
        footer: this.overlayFooter(o),
        selectedLine: o.mode === "info" && o.cardSel >= 0
          ? o.targets[o.cardSel]?.cardLine
          : undefined,
        // Source (the toggled-to source view, or a peek that is itself source)
        // is drawn as a blue editor window; a structured card is a grey dialog.
        sourceView: o.mode === "source" ||
          (o.mode === "info" && !!o.infoIsSource),
      }
      : null;
    return {
      top: this.top,
      left: this.left,
      width: this.width,
      height: this.height,
      color: this.color,
      showLineNumbers: this.lineNumberMode !== "off",
      lineNumbers: this.lineNumberMode === "off" ? null : this.gutterNumbers(),
      displayMode: this.displayMode,
      selected: this.displaySelected(),
      matches: this.query.length > 0 ? this.displayMatches() : null,
      currentMatch: this.currentMatch,
      message: this.message,
      inputLine: this.mode === "search"
        ? `/${this.input}`
        : this.mode === "deflookup"
        ? `definition: ${this.input}`
        : this.mode === "filePicker"
        ? `find file: ${this.files?.join(this.pickerDir, this.pickerFilter)}`
        : null,
      dialog: this.promptDialog(),
      overlay: ov,
      cursor: this.cursorOn && this.buffer
        ? { line: this.toDisplay(this.buffer.row), col: this.buffer.col }
        : null,
      editHint: this.cursorOn ? this.editHint() : null,
      canExpand: this.canExpand(),
      canEdit: !this.cursorOn && !!this.source?.editable,
      hasNonPrintables: this.hasNonPrintables(),
      notice: null,
      currentFile: this.currentFile(),
    };
  }

  /** The edit-mode key hints for the status line. */
  private editHint(): KeyHint[] {
    const hints: KeyHint[] = [
      { key: "Esc", label: "Done" },
      { key: "^S", label: "Search" },
      { key: "^R", label: "Revert" },
    ];
    if (this.source?.policy) hints.push({ key: "^L", label: "Expand" });
    hints.push({ key: "^X^S", label: "Save" }, { key: "^X^F", label: "Open" });
    return hints;
  }

  /** The modal dialog for whichever confirmation prompt is open, or null when no
   * prompt is up. Rebuilt each frame from the current buffer and source. */
  private promptDialog(): DialogState | null {
    let dialog: DialogState | null = null;
    if (this.mode === "savePrompt") dialog = this.saveDialog();
    else if (this.mode === "amendPrompt") dialog = this.amendDialog();
    else if (this.mode === "revertPrompt") dialog = this.revertDialog();
    if (!dialog) return null;
    // -1 means no button is focused (a prompt with no default, before Tab).
    const focus = this.dialogFocus < 0
      ? -1
      : clamp(this.dialogFocus, 0, Math.max(0, dialog.buttons.length - 1));
    return { ...dialog, focus };
  }

  /** Rest the current prompt's Tab focus on its default button, called as each
   * prompt opens. A prompt with no default button (the diff revert) starts with
   * no focus — an index of -1 — so Space and Enter do nothing until Tab picks a
   * button, keeping a stray Enter from reverting. */
  private focusDefaultButton(): void {
    const buttons = this.promptDialog()?.buttons ?? [];
    this.dialogFocus = buttons.findIndex((b) => b.kind === "default");
  }

  /** The save-changes confirmation: names what a save writes, lists the files
   * when there is more than one, and offers save / discard / cancel. */
  private saveDialog(): DialogState {
    const files = this.editedFiles;
    const n = files.length;
    const amend = this.source && this.buffer
      ? this.source.pendingAmend?.(this.buffer.baseline(), this.buffer.text())
      : null;
    const what = n === 0
      ? (amend ? "the commit message" : "your edits")
      : n === 1
      ? files[0]
      : `${n} files`;
    const body = [`Save changes to ${what}?`];
    if (n > 1) {
      const max = 6;
      body.push("");
      for (const f of files.slice(0, max)) body.push(`  ${f}`);
      if (n > max) body.push(`  … and ${n - max} more`);
    }
    return {
      title: "Save Changes",
      body,
      buttons: [
        { label: "Save", hotkey: "s", kind: "default" },
        { label: "Discard", hotkey: "d" },
        { label: "Cancel", hotkey: "c", kind: "cancel" },
      ],
    };
  }

  /** The amend-commit confirmation, naming the commit and its subject. */
  private amendDialog(): DialogState {
    const amend = this.source && this.buffer
      ? this.source.pendingAmend?.(this.buffer.baseline(), this.buffer.text())
      : null;
    const sha = amend?.sha.slice(0, 9) ?? "";
    const full = amend?.subject ?? "";
    const subject = full.length > 46 ? `${full.slice(0, 45)}…` : full;
    return {
      title: "Amend Commit",
      body: [`Amend commit ${sha}?`, `“${subject}”`],
      buttons: [
        { label: "Yes", hotkey: "y", kind: "default" },
        { label: "No", hotkey: "n", kind: "cancel" },
      ],
    };
  }

  /** The revert confirmation. A diff offers only the scopes that apply where the
   * cursor sits — the hunk and/or file it is in, or the commit message — plus
   * all; a plain file reverts wholesale. */
  private revertDialog(): DialogState {
    if (!this.source?.policy) {
      return {
        title: "Revert",
        body: ["Revert all edits?"],
        buttons: [
          { label: "Yes", hotkey: "y", kind: "default" },
          { label: "Cancel", hotkey: "c", kind: "cancel" },
        ],
      };
    }
    const s = this.revertScopesAt();
    const buttons: DialogButton[] = [];
    if (s.chunk) buttons.push({ label: "Hunk", hotkey: "h" });
    if (s.file) buttons.push({ label: "File", hotkey: "f" });
    if (s.message) buttons.push({ label: "Message", hotkey: "m" });
    buttons.push({ label: "All", hotkey: "a" });
    buttons.push({ label: "Cancel", hotkey: "c", kind: "cancel" });
    return { title: "Revert", body: ["Revert which changes?"], buttons };
  }

  handleKey(key: Key): void {
    // A reveal is animated by the driver over the frames after the key that
    // caused it, so the next key ends it whatever it was. A message that takes
    // itself away goes now rather than waiting out its moment, before this key
    // has the chance to set one of its own.
    this.pendingReveal = null;
    this.pendingPush = null;
    this.expireMessage();
    if (
      this.mode === "savePrompt" || this.mode === "amendPrompt" ||
      this.mode === "revertPrompt"
    ) {
      this.handleDialogKey(key);
      return;
    }
    if (this.mode === "filePicker") {
      this.handleFilePicker(key);
      return;
    }
    if (this.mode === "search" || this.mode === "deflookup") {
      this.handleInputKey(key);
      return;
    }
    if (this.chord === "ctrl-x") {
      this.handleChord(key);
      return;
    }
    if (this.overlay) {
      this.handleOverlayKey(key);
      return;
    }
    this.handleNormalKey(key);
  }

  // --- internals -------------------------------------------------------------

  private contentRows(): number {
    return Math.max(1, this.height - 1);
  }

  private clampScroll(): void {
    this.top = clamp(this.top, 0, maxTop(this.displayCount(), this.height));
    this.left = clamp(this.left, 0, this.maxLineLen);
  }

  private selectedNode(): StructureNode | null {
    return this.selectedIndex !== null
      ? this.doc.flatStructure[this.selectedIndex] ?? null
      : null;
  }

  private selectNode(idx: number): void {
    if (idx < 0 || idx >= this.doc.flatStructure.length) return;
    this.selectedIndex = idx;
    const node = this.doc.flatStructure[idx];
    // Keep the viewport stable: only scroll if the selection's anchor (its first
    // line, where the block opens) would otherwise be off screen. Horizontal
    // scroll is left untouched for the same reason. Anchors are in display rows,
    // since a collapsed file's lines share its summary row.
    this.top = scrollToAnchor(
      this.toDisplay(node.startLine),
      this.top,
      this.height,
      this.displayCount(),
    );
    this.message = "";
  }

  /** Remember the current overlay so a later Esc returns to it, before a link
   * opens a new one over the top. */
  private pushOverlay(): void {
    if (this.overlay) {
      this.overlayStack.push({
        overlay: this.overlay,
        scroll: this.overlayScroll,
      });
    }
  }

  /** Close the overlay and discard the whole navigation stack. */
  private closeOverlay(): void {
    this.overlay = null;
    this.overlayScroll = 0;
    this.overlayStack = [];
  }

  private openPeek(node: StructureNode, expanded = false): void {
    const card = buildPeekCard(this.doc, node, this.semantics, expanded);
    this.overlay = {
      title: card.title,
      info: card.info,
      source: card.source,
      mode: "info",
      targets: card.targets,
      cardSel: -1,
      node,
    };
    this.overlayScroll = 0;
  }

  /** Rebuild the open card with every truncated list shown in full, keeping the
   * scroll position so the newly revealed entries appear where "… N more" was. */
  private expandCard(node: StructureNode): void {
    const scroll = this.overlayScroll;
    const card = buildPeekCard(this.doc, node, this.semantics, true);
    this.overlay = {
      ...this.overlay!,
      info: card.info,
      source: card.source,
      targets: card.targets,
      cardSel: -1,
    };
    this.overlayScroll = scroll;
  }

  private lookupDefinition(name: string): void {
    const defs = this.doc.definitions.get(name);
    if (!defs || defs.length === 0) {
      this.message = `No definition found for "${name}"`;
      return;
    }
    const def = defs[defs.length - 1];
    // Prefer the structure node for this declaration so the card is available.
    const node = this.doc.flatStructure.find((n) =>
      n.startOffset === def.startOffset && n.endOffset === def.endOffset
    );
    if (node) {
      const card = buildPeekCard(this.doc, node, this.semantics);
      this.overlay = {
        title: `definition: ${card.title}`,
        info: card.info,
        source: card.source,
        mode: "info",
        targets: card.targets,
        cardSel: -1,
        node,
      };
    } else {
      this.overlay = {
        title: `definition: ${name}  (${def.kind})`,
        info: this.doc.lines.slice(def.startLine, def.endLine + 1),
        mode: "info",
        targets: [],
        cardSel: -1,
        staticFooter: "↑/↓ scroll · esc close",
        infoIsSource: true,
      };
    }
    this.overlayScroll = 0;
  }

  private activeOverlayLines(overlay: PeekOverlay): readonly Line[] {
    return overlay.mode === "source" && overlay.source
      ? overlay.source
      : overlay.info;
  }

  private overlayFooter(overlay: PeekOverlay): string {
    if (overlay.staticFooter) return overlay.staticFooter;
    const parts: string[] = [];
    if (overlay.mode === "info" && overlay.targets.length > 0) {
      parts.push("↑/↓ select", "enter open");
    } else {
      parts.push("↑/↓ scroll");
    }
    if (overlay.node) parts.push("z reveal");
    if (overlay.source) {
      parts.push(overlay.mode === "info" ? "tab source" : "tab card");
    }
    // Esc walks back through followed links; only closes at the bottom.
    if (this.overlayStack.length > 0) parts.push("esc back", "q close");
    else parts.push("esc close");
    return parts.join(" · ");
  }

  /** Move the card's reference selection and keep it visible. */
  private moveCardSelection(delta: number): void {
    const o = this.overlay;
    if (!o || o.mode !== "info" || o.targets.length === 0) return;
    if (delta > 0) {
      o.cardSel = Math.min(o.cardSel + 1, o.targets.length - 1);
    } else {
      if (o.cardSel <= 0) {
        o.cardSel = -1;
        this.overlayScroll = 0;
        return;
      }
      o.cardSel -= 1;
    }
    const line = o.targets[o.cardSel].cardLine;
    const innerH = overlayBox(this.width, this.height).innerH;
    if (line < this.overlayScroll) this.overlayScroll = line;
    else if (line >= this.overlayScroll + innerH) {
      this.overlayScroll = line - innerH + 1;
    }
  }

  /** Open an external definition file in a read-only overlay, framed at the
   * definition line. */
  private openExternalFile(target: CardTarget): void {
    const lines = this.semantics?.fileLines(target.filePath!);
    if (!lines) {
      this.message = `Cannot open ${target.filePath}`;
      return;
    }
    // Lead the title with the filename and line: the overlay centres and
    // left-truncates titles, so a raw absolute path would keep only its shared
    // workspace prefix and drop the identifying part.
    const name = target.filePath!.split(/[\\/]/).pop() ?? target.filePath!;
    this.overlay = {
      title: `${name}  ·  line ${target.destLine + 1}`,
      info: lines,
      mode: "info",
      targets: [],
      cardSel: -1,
      infoIsSource: true,
    };
    this.overlayScroll = clamp(
      target.destLine - 2,
      0,
      Math.max(0, lines.length - 1),
    );
  }

  /** Index of the node a definition target denotes. Nested nodes can share a
   * start offset (diff views clamp them), so a matching end offset wins. */
  private findTargetIndex(target: CardTarget): number {
    if (target.defOffset === undefined) return -1;
    if (target.defEndOffset !== undefined) {
      const exact = this.doc.flatStructure.findIndex((n) =>
        n.startOffset === target.defOffset &&
        n.endOffset === target.defEndOffset
      );
      if (exact >= 0) return exact;
    }
    return this.doc.flatStructure.findIndex((n) =>
      n.startOffset === target.defOffset
    );
  }

  /** Jump the main view to a card target, selecting the relevant node. This
   * leaves the overlay for the main view, so the whole navigation stack goes. */
  private jumpToTarget(target: CardTarget): void {
    this.overlay = null;
    this.overlayScroll = 0;
    this.overlayStack = [];
    let idx = this.findTargetIndex(target);
    if (idx < 0) idx = nodeAtLine(this.doc.flatStructure, target.destLine);
    this.selectedIndex = idx >= 0 ? idx : null;
    const node = idx >= 0 ? this.doc.flatStructure[idx] : null;
    // Frame the whole node (centred if it fits, else its top ~1/10 down). When
    // no node resolves, frame the single destination line.
    this.top = node
      ? frameTop(
        this.toDisplay(node.startLine),
        this.toDisplay(node.endLine),
        this.height,
        this.displayCount(),
      )
      : frameTop(
        this.toDisplay(target.destLine),
        this.toDisplay(target.destLine),
        this.height,
        this.displayCount(),
      );
    const destCol = this.displayCol(target.destLine, target.destCol);
    if (destCol < this.left || destCol >= this.left + this.width) {
      this.left = clamp(destCol - 4, 0, this.maxLineLen);
    }
    this.message = `→ line ${target.destLine + 1}`;
  }

  /** The structure node a card target points at, if any. */
  private resolveTargetNode(target: CardTarget): StructureNode | null {
    const idx = this.findTargetIndex(target);
    if (idx >= 0) return this.doc.flatStructure[idx];
    const at = nodeAtLine(this.doc.flatStructure, target.destLine);
    return at >= 0 ? this.doc.flatStructure[at] : null;
  }

  /** What `z` reveals: the selected reference, else the card's own subject. */
  private overlayRevealTarget(overlay: PeekOverlay): CardTarget | null {
    if (overlay.cardSel >= 0) return overlay.targets[overlay.cardSel] ?? null;
    const node = overlay.node;
    if (!node) return null;
    return {
      cardLine: 0,
      destLine: node.startLine,
      destCol: node.startCol,
      defOffset: node.startOffset,
      defEndOffset: node.endOffset,
    };
  }

  private runSearch(jumpForward: boolean): void {
    this.matches = findMatches(this.doc, this.query);
    if (this.matches.length === 0) {
      this.currentMatch = 0;
      this.message = this.query ? `Pattern not found: ${this.query}` : "";
      return;
    }
    // The viewport anchor is a display row; match lines are document lines.
    const anchor = this.toDoc(this.top) - 1;
    const idx = nextMatchIndex(this.matches, anchor, -1, jumpForward);
    this.currentMatch = idx < 0 ? 0 : idx;
    this.revealMatch();
  }

  /** Begin a search from edit mode (Ctrl-S): anchor it at the cursor so the
   * focused match is the next one at or after the cursor, and seed the input
   * with the last query so a bare Ctrl-S then Enter repeats it. */
  private enterEditSearch(): void {
    this.searchAnchor = this.buffer
      ? { row: this.buffer.row, col: this.buffer.col }
      : null;
    this.mode = "search";
    this.input = this.query;
    this.refreshSearchMatches();
  }

  /** Recompute the full match set for the current query and focus one: for an
   * edit-mode search, the first editable match at or after the anchor (so the
   * cursor lands somewhere it can type); for a normal search, the first in the
   * document. `this.matches` stays the full set, so leaving the search does not
   * leave normal-mode n/N stepping a filtered subset. */
  private refreshSearchMatches(): void {
    this.matches = findMatches(this.doc, this.query);
    if (this.matches.length === 0) {
      this.currentMatch = 0;
      return;
    }
    const a = this.searchAnchor;
    this.currentMatch = a
      ? this.firstEditableMatch(
        nextMatchIndex(this.matches, a.row, a.col - 1, true),
      )
      : 0;
    this.revealMatch();
  }

  /** The first editable match at or after index `from` (wrapping), for an
   * edit-mode search; `from` itself when none is editable. */
  private firstEditableMatch(from: number): number {
    const start = from < 0 ? 0 : from;
    for (let n = 0; n < this.matches.length; n++) {
      const i = (start + n) % this.matches.length;
      if (this.isEditableLine(this.matches[i].line)) return i;
    }
    return start;
  }

  /** Whether the cursor may edit `line` under the source's policy (a diff). A
   * file (no policy) is editable everywhere. */
  private isEditableLine(line: number): boolean {
    const pol = this.source?.policy;
    if (!pol) return true;
    const lines = this.buffer?.lines ?? this.doc.lines.map((l) => l.text);
    return pol.editStart(lines, line) !== null;
  }

  /** Land the edit cursor on the focused match (edit-mode search commit). */
  private placeCursorAtMatch(): void {
    const m = this.matches[this.currentMatch];
    if (!m || !this.cursorOn || !this.buffer) return;
    this.buffer.place(m.line, m.start);
    this.ensureCursorVisible();
  }

  private stepMatch(forward: boolean): void {
    if (this.matches.length === 0) {
      this.message = "No matches";
      return;
    }
    const cur = this.matches[this.currentMatch];
    let idx = nextMatchIndex(this.matches, cur.line, cur.start, forward);
    // An edit-mode search (Ctrl-S) steps only between editable matches.
    if (this.searchAnchor) idx = this.firstEditableMatch(idx);
    this.currentMatch = idx;
    this.revealMatch();
  }

  private revealMatch(): void {
    const m = this.matches[this.currentMatch];
    if (!m) return;
    const row = this.toDisplay(m.line);
    if (row < this.top || row >= this.top + this.contentRows()) {
      this.top = clamp(
        row - Math.floor(this.contentRows() / 2),
        0,
        maxTop(this.displayCount(), this.height),
      );
    }
    const col = this.displayCol(m.line, m.start);
    if (col < this.left || col >= this.left + this.width) {
      this.left = clamp(col - 4, 0, this.maxLineLen);
    }
    this.message = "";
  }

  /** The display column a source column maps to on `line` under the current
   * mode — what horizontal scrolling counts in, since a compacting mode draws
   * fewer columns than the line has source code points. */
  private displayCol(line: number, sourceCol: number): number {
    const l = this.doc.lines[line];
    return l ? displayColumnOf(l, this.displayMode, sourceCol) : sourceCol;
  }

  private handleInputKey(key: Key): void {
    if (key.name === "escape") {
      this.mode = "normal";
      this.input = "";
      this.searchAnchor = null;
      if (this.query.length === 0) this.matches = [];
      // An edit-mode search scrolled to matches while the cursor stayed put;
      // bring the viewport back so the text cursor is on screen.
      if (this.cursorOn) this.ensureCursorVisible();
      return;
    }
    // Ctrl-S inside a search steps to the next match (Emacs-style repeat).
    if (key.name === "ctrl-s") {
      if (this.mode === "search") this.stepMatch(true);
      return;
    }
    if (key.name === "enter") {
      if (this.mode === "search") {
        this.query = this.input;
        // An edit-mode search lands the cursor on the focused match; a
        // normal-mode search jumps the viewport to it.
        if (this.searchAnchor || this.cursorOn) this.placeCursorAtMatch();
        else this.runSearch(true);
      } else {
        this.lookupDefinition(this.input.trim());
      }
      this.mode = "normal";
      this.input = "";
      this.searchAnchor = null;
      return;
    }
    if (key.name === "backspace") {
      this.input = this.input.slice(0, -1);
      if (this.mode === "search") {
        this.query = this.input;
        this.refreshSearchMatches();
      }
      return;
    }
    if (key.char && key.char >= " ") {
      this.input += key.char;
      if (this.mode === "search") {
        this.query = this.input;
        this.refreshSearchMatches();
      }
    }
  }

  private handleOverlayKey(key: Key): void {
    const overlay = this.overlay;
    if (!overlay) return;
    // Stop scrolling once the last line reaches the bottom of the box, so the
    // final line does not drift up past the frame — the same clamp the main
    // view uses.
    const innerH = overlayBox(this.width, this.height).innerH;
    const maxScroll = Math.max(
      0,
      this.activeOverlayLines(overlay).length - innerH,
    );
    const hasTargets = overlay.mode === "info" && overlay.targets.length > 0;
    switch (key.name) {
      case "escape":
        // Walk back through the stack of followed links; the last Esc, with an
        // empty stack, closes the overlay.
        if (this.overlayStack.length > 0) {
          const prev = this.overlayStack.pop()!;
          this.overlay = prev.overlay;
          this.overlayScroll = prev.scroll;
        } else {
          this.overlay = null;
          this.overlayScroll = 0;
        }
        break;
      case "q":
        this.closeOverlay();
        break;
      case "enter":
        // Follow the selected reference, pushing this card so Esc returns to it:
        // open the referenced node's card, or — when the definition lives in
        // another file — open that file over the top.
        if (hasTargets && overlay.cardSel >= 0) {
          const target = overlay.targets[overlay.cardSel];
          if (target.expand) {
            this.expandCard(overlay.node!);
          } else if (target.filePath) {
            this.pushOverlay();
            this.openExternalFile(target);
          } else {
            const node = this.resolveTargetNode(target);
            if (node) {
              this.pushOverlay();
              this.openPeek(node);
            } else this.message = "Nothing to open for this reference";
          }
        } else {
          this.closeOverlay();
        }
        break;
      case "z": {
        // Reveal the target: an external file opens in place; an in-blob target
        // closes the card and centres the main view on it. A "… N more" line has
        // no destination to reveal.
        const reveal = this.overlayRevealTarget(overlay);
        if (reveal?.expand) break;
        if (reveal?.filePath) {
          // Opening the file over the card: Esc returns to the card.
          this.pushOverlay();
          this.openExternalFile(reveal);
        } else if (reveal) {
          this.jumpToTarget(reveal); // exits the card viewer entirely
        }
        break;
      }
      case "tab":
        if (overlay.source) {
          overlay.mode = overlay.mode === "info" ? "source" : "info";
          overlay.cardSel = -1;
          this.overlayScroll = 0;
        }
        break;
      case "down":
      case "j":
        if (hasTargets) this.moveCardSelection(1);
        else this.overlayScroll = clamp(this.overlayScroll + 1, 0, maxScroll);
        break;
      case "up":
      case "k":
        if (hasTargets) this.moveCardSelection(-1);
        else this.overlayScroll = clamp(this.overlayScroll - 1, 0, maxScroll);
        break;
      case "pagedown":
      case "space":
        this.overlayScroll = clamp(this.overlayScroll + 10, 0, maxScroll);
        break;
      case "pageup":
        this.overlayScroll = clamp(this.overlayScroll - 10, 0, maxScroll);
        break;
    }
  }

  private handleNormalKey(key: Key): void {
    this.message = "";

    // Editor chords / save, available in both cursor and pager modes.
    if (key.name === "ctrl-x" && this.source) {
      this.chord = "ctrl-x";
      return;
    }
    if (key.name === "f3") {
      this.requestSave();
      return;
    }
    // Alt+arrows scroll/pan — "do what the cursor keys used to do".
    if (key.alt && isArrowName(key.name)) {
      this.scrollOrPan(key.name);
      return;
    }
    if (this.cursorOn) {
      this.handleEditKey(key);
      return;
    }
    // Cursor off: a bare arrow scrolls or pans the view, like the vi keys.
    if (!key.alt && isArrowName(key.name)) {
      this.scrollOrPan(key.name);
      return;
    }

    const rows = this.contentRows();
    const lastTop = maxTop(this.displayCount(), this.height);
    switch (key.name) {
      case "q":
      case "ctrl-c":
        this.requestQuit();
        return;
      case "?":
        this.overlay = helpOverlay();
        this.overlayScroll = 0;
        return;
      case "/":
        this.mode = "search";
        this.input = "";
        this.searchAnchor = null;
        return;
      case "e":
        // Enter edit mode: reveal the text cursor at the top of the view.
        this.revealCursor();
        return;
      case "t":
        this.mode = "deflookup";
        this.input = this.selectedNode()?.name ?? "";
        return;
      case "n":
        this.stepMatch(true);
        return;
      case "N":
        this.stepMatch(false);
        return;
      case "j":
        this.top = clamp(this.top + 1, 0, lastTop);
        return;
      case "k":
        this.top = clamp(this.top - 1, 0, lastTop);
        return;
      case "h":
        this.left = clamp(this.left - HORIZONTAL_STEP, 0, this.maxLineLen);
        return;
      case "l":
        this.left = clamp(this.left + HORIZONTAL_STEP, 0, this.maxLineLen);
        return;
      case "space":
      case "pagedown":
      case "ctrl-f":
        this.top = clamp(this.top + rows - 1, 0, lastTop);
        return;
      case "b":
      case "pageup":
      case "ctrl-b":
        this.top = clamp(this.top - rows + 1, 0, lastTop);
        return;
      case "ctrl-d":
        this.top = clamp(this.top + (rows >> 1), 0, lastTop);
        return;
      case "ctrl-u":
        this.top = clamp(this.top - (rows >> 1), 0, lastTop);
        return;
      case "g":
      case "home":
        this.top = 0;
        this.left = 0;
        return;
      case "G":
      case "end":
        this.top = lastTop;
        return;
      case "ctrl-l":
        this.performExpand();
        return;
      case "w":
        this.navigateTree(treePrevSibling);
        return;
      case "s":
        this.navigateTree(treeNextSibling);
        return;
      case "a":
        this.navigateTree(treeParent);
        return;
      case "d":
        this.navigateTree(treeChild);
        return;
      case "tab":
        this.navigateTree(treePreOrderNext);
        return;
      case "shift-tab":
        this.navigateTree(treePreOrderPrev);
        return;
      case "enter": {
        const node = this.selectedNode();
        if (node) this.openPeek(node);
        else {
          this.message =
            "Select a node first (wasd / tab), then Enter for its info card";
        }
        return;
      }
      case "z": {
        const node = this.selectedNode();
        if (node) {
          this.top = frameTop(
            this.toDisplay(node.startLine),
            this.toDisplay(node.endLine),
            this.height,
            this.displayCount(),
          );
        }
        return;
      }
      case "#":
        this.cycleLineNumbers();
        return;
      case "c":
        this.cycleDisplayMode();
        return;
      case "f":
        this.toggleCurrentFile();
        return;
      case "F":
        this.collapseAllFiles();
        return;
      case "E":
        this.expandAllFiles();
        return;
      case "T":
        this.collapseTestFiles();
        return;
      case "escape":
        this.selectedIndex = null;
        this.query = "";
        this.matches = [];
        this.message = "";
        return;
    }
  }

  /** Step to the next non-printable display mode and report it. */
  private cycleDisplayMode(): void {
    const i = DISPLAY_MODES.indexOf(this.displayMode);
    this.displayMode = DISPLAY_MODES[(i + 1) % DISPLAY_MODES.length];
    this.message = `Non-printables: ${displayModeLabel(this.displayMode)}`;
  }

  // --- file-fold commands ----------------------------------------------------

  private ensureDiffForFolding(): boolean {
    if (this.foldFiles().length === 0) {
      this.message = "Hiding files is only available in a diff view.";
      return false;
    }
    return true;
  }

  /** The document line the fold commands anchor the viewport to: the selected
   * node's first line, else the line at the top of the viewport. */
  private foldAnchorLine(): number {
    const node = this.selectedNode();
    return node ? node.startLine : this.toDoc(this.top);
  }

  /** After the collapsed set changes, refresh the plan and keep `anchorDoc`
   * (a document line) at the same spot on screen. */
  private applyFoldChange(anchorDoc: number): void {
    this.markFoldChanged();
    this.top = clamp(
      this.toDisplay(anchorDoc),
      0,
      maxTop(this.displayCount(), this.height),
    );
  }

  /** Toggle the file the viewport (or selection) is on between shown and hidden. */
  private toggleCurrentFile(): void {
    if (!this.ensureDiffForFolding()) return;
    const files = this.foldFiles();
    const line = this.foldAnchorLine();
    const file = files.find((f) => line >= f.headerLine && line <= f.endLine) ??
      files.find((f) => f.headerLine >= line) ?? files[files.length - 1];
    if (this.collapsed.has(file.index)) {
      this.collapsed.delete(file.index);
      this.message = `Showing ${file.path}`;
    } else {
      this.collapsed.add(file.index);
      this.message = `Hiding ${file.path}`;
    }
    this.applyFoldChange(file.headerLine);
  }

  /** Hide every file (collapse all to summary lines). */
  private collapseAllFiles(): void {
    if (!this.ensureDiffForFolding()) return;
    const anchor = this.foldAnchorLine();
    for (const f of this.foldFiles()) this.collapsed.add(f.index);
    this.applyFoldChange(anchor);
    this.message = "Hid all files.";
  }

  /** Show every file (expand all). */
  private expandAllFiles(): void {
    if (!this.ensureDiffForFolding()) return;
    const anchor = this.foldAnchorLine();
    this.collapsed.clear();
    this.applyFoldChange(anchor);
    this.message = "Showing all files.";
  }

  /** Hide every test / test-support file, leaving the rest shown. */
  private collapseTestFiles(): void {
    if (!this.ensureDiffForFolding()) return;
    const anchor = this.foldAnchorLine();
    let n = 0;
    for (const f of this.foldFiles()) {
      if (f.isTest && !this.collapsed.has(f.index)) {
        this.collapsed.add(f.index);
        n++;
      }
    }
    this.applyFoldChange(anchor);
    this.message = n > 0
      ? `Hid ${n} test file${n === 1 ? "" : "s"}.`
      : "No shown test files to hide.";
  }

  // --- editing ---------------------------------------------------------------

  private scrollOrPan(name: string): void {
    const lastTop = maxTop(this.displayCount(), this.height);
    if (name === "up") this.top = clamp(this.top - 1, 0, lastTop);
    else if (name === "down") this.top = clamp(this.top + 1, 0, lastTop);
    else if (name === "left") {
      this.left = clamp(this.left - HORIZONTAL_STEP, 0, this.maxLineLen);
    } else if (name === "right") {
      this.left = clamp(this.left + HORIZONTAL_STEP, 0, this.maxLineLen);
    }
  }

  /** Show the text cursor at the top of the viewport, if the view is editable. */
  private revealCursor(): void {
    if (!this.source?.editable || !this.buffer) {
      this.message = this.source?.reason ??
        "This view has no underlying file to edit.";
      return;
    }
    this.cursorOn = true;
    this.selectedIndex = null;
    // Editing relies on every source column mapping to one display column, which
    // only the first mode guarantees (it hides nothing and collapses nothing).
    this.displayMode = DISPLAY_MODES[0];
    // Editing works on the full text, so expand every folded file; the top
    // display row becomes its document line.
    const topDoc = this.toDoc(this.top);
    this.clearFolds();
    this.top = topDoc;
    this.buffer.place(topDoc, 0);
    this.seedHighlighter();
    this.ensureCursorVisible();
  }

  private markFoldChanged(): void {
    this.foldVersion++;
    this.foldPlanCache = undefined;
  }

  private clearFolds(): void {
    if (this.collapsed.size === 0) return;
    this.collapsed.clear();
    this.markFoldChanged();
  }

  /** Create (or re-baseline) the incremental highlighter, seeded with the
   * current document's colours at the current buffer text. Called when editing
   * starts and after the deferred re-parse — the two moments the document's
   * lines and the buffer text are known to agree — so a diff's live highlighter
   * can reuse the workspace-coloured lines for everything an edit doesn't touch. */
  private seedHighlighter(): void {
    this.highlighter = this.source?.createHighlighter?.(
      this.buffer!.text(),
      this.currentDoc.lines,
    );
  }

  private handleEditKey(key: Key): void {
    const b = this.buffer!;
    if (key.alt) {
      switch (key.name) {
        case "f":
          b.moveWordForward();
          return this.afterMove();
        case "b":
          b.moveWordBackward();
          return this.afterMove();
        case "v":
          return this.cursorPage(-1);
        case "<":
          b.moveBufferStart();
          return this.afterMove();
        case ">":
          b.moveBufferEnd();
          return this.afterMove();
        case "d":
          if (this.guardForwardEdit()) {
            b.killWordForward();
            this.afterEdit();
          }
          return;
        case "y":
          if (this.source?.policy) {
            this.message = "Yank-pop isn't available while editing a diff.";
            return;
          }
          b.yankPop();
          return this.afterEdit();
        case "l":
          if (this.allowEdit(false)) {
            b.lowercaseWord();
            this.afterEdit();
          }
          return;
        case "u":
          if (this.allowEdit(false)) {
            b.uppercaseWord();
            this.afterEdit();
          }
          return;
        case "c":
          if (this.allowEdit(false)) {
            b.capitalizeWord();
            this.afterEdit();
          }
          return;
        case "backspace":
          if (this.guardBackwardEdit()) {
            b.killWordBackward();
            this.afterEdit();
          }
          return;
      }
      return; // unmodelled Alt combo
    }
    switch (key.name) {
      case "left":
        b.moveLeft();
        return this.afterMove();
      case "right":
        b.moveRight();
        return this.afterMove();
      case "up":
        b.moveUp();
        return this.afterMove();
      case "down":
        b.moveDown();
        return this.afterMove();
      case "home":
      case "ctrl-a":
        b.moveLineStart();
        return this.afterMove();
      case "end":
      case "ctrl-e":
        b.moveLineEnd();
        return this.afterMove();
      case "ctrl-b":
        b.moveLeft();
        return this.afterMove();
      case "ctrl-f":
        b.moveRight();
        return this.afterMove();
      case "ctrl-p":
        b.moveUp();
        return this.afterMove();
      case "ctrl-n":
        b.moveDown();
        return this.afterMove();
      case "pageup":
        return this.cursorPage(-1);
      case "pagedown":
      case "ctrl-v":
        return this.cursorPage(1);
      case "escape":
        this.cursorOn = false;
        this.reparse(); // refresh structure before returning to navigation
        return;
      case "ctrl-s":
        this.enterEditSearch();
        return;
      case "ctrl-r":
        this.openRevertPrompt();
        return;
      case "ctrl-l":
        this.performExpand();
        return;
      case "ctrl-c":
        this.requestQuit();
        return;
      case "delete":
      case "ctrl-d":
        if (this.guardForwardEdit()) {
          b.deleteForward();
          this.afterEdit();
        }
        return;
      case "backspace":
        this.handleBackspace();
        return;
      case "enter": {
        // A commit-message line splits into two indented message lines, plain
        // text — no diff pairing, no hunk-count bookkeeping.
        if (this.inMessageRow()) {
          if (this.allowEdit(false, false)) {
            b.insert(`\n${this.source!.policy!.messageIndent}`);
            this.afterEdit();
          }
          return;
        }
        const prefix = this.source?.policy?.insertPrefix;
        if (prefix !== undefined) {
          if (this.allowEdit(false, false)) {
            const start = this.editStart() ?? 1;
            const onContext = b.lines[b.row]?.[0] === " ";
            // Enter splits the line at the cursor. On a context line the result
            // is shown minimally: an empty half just adds a blank line and the
            // line stays unchanged context (start → blank above, end → blank
            // below); a split with content on both sides changes the line, so it
            // becomes a removed/added pair and the break divides the added line
            // into `+head` and `+tail`. An added line is already new, so it just
            // splits at the cursor. Either way the new side gains one line.
            if (onContext && b.col <= start) {
              // Empty head: the blank added line goes above and the cursor
              // follows the content onto the line below, keeping its place at
              // the line start (past the marker).
              b.spliceLines(b.row, 0, [prefix], 1, start);
              this.splitRow = null;
            } else if (onContext && b.col < b.currentLineLength()) {
              this.prepareContextEdit();
              b.insert(`\n${prefix}`);
            } else {
              b.insert(`\n${prefix}`);
            }
            this.adjustHunkCounts(0, 1);
            this.afterEdit();
          }
        } else {
          b.insertNewline();
          this.afterEdit();
        }
        return;
      }
      case "tab":
        if (this.allowEdit(false)) {
          b.insert("  ");
          this.afterEdit();
        }
        return;
      case "ctrl-k":
        if (this.guardForwardEdit()) {
          b.killLine();
          this.afterEdit();
        }
        return;
      case "ctrl-y": {
        const top = b.killRing[0] ?? "";
        if (this.allowEdit(top.includes("\n"))) {
          b.yank();
          this.afterEdit();
        }
        return;
      }
      case "ctrl-w":
        if (this.guardRegionEdit()) {
          b.killRegion();
          this.afterEdit();
        }
        return;
      case "ctrl-`": // C-Space (NUL) — set the mark
      case "ctrl-space":
        b.setMark();
        this.message = "Mark set";
        return;
      case "space":
        if (this.allowEdit(false)) {
          b.insert(" ");
          this.afterEdit();
        }
        return;
    }
    if (key.char && key.char >= " " && !key.ctrl) {
      // A key.char carrying a newline (e.g. a future bracketed-paste handler)
      // would add lines; treat it as a line change so a diff refuses it.
      if (this.allowEdit(key.char.includes("\n"))) {
        b.insert(key.char);
        this.afterEdit();
      }
    }
  }

  /**
   * Before changing a context line in a diff, split it into a removed line (the
   * original) and an added line (the one about to be edited), leaving the cursor
   * on the added line at the same column. So a change to a context line shows as
   * a `-`/`+` pair, exactly as an inserted line shows as `+`. Count-neutral: a
   * context line is one old plus one new line, and so is the `-`/`+` pair, so
   * the hunk header stays valid. A no-op on an added or removed line, or a file
   * (no diff policy).
   */
  private prepareContextEdit(): void {
    if (!this.source?.policy || !this.buffer) return;
    // A commit-message line is plain indented text, not a diff line: editing it
    // must not split it into a removed/added pair.
    if (this.inMessageRow()) return;
    const b = this.buffer;
    const line = b.lines[b.row];
    if (line === undefined || line[0] !== " ") return;
    const content = line.slice(1);
    const col = b.col;
    // A single-line region's mark rides along onto the added line.
    if (b.mark && b.mark.row === b.row) {
      b.mark = { row: b.row + 1, col: b.mark.col };
    }
    b.spliceLines(b.row, 1, [`-${content}`, `+${content}`], 1, col);
    this.splitRow = b.row; // the added line, so undoing the edit can collapse it
  }

  /** After editing a diff, collapse the added line a split just produced back
   * into a context line when its content again matches the removed line above it
   * — you undid the change. Scoped to the row {@link prepareContextEdit} created
   * (`splitRow`), so editing an author-written `-`/`+` pair to match does not
   * silently drop their removed line. Count-neutral, the inverse of the split. */
  private collapseUnchangedPair(): void {
    if (!this.source?.policy || !this.buffer) return;
    const b = this.buffer;
    if (b.row !== this.splitRow) return;
    const cur = b.lines[b.row];
    const above = b.lines[b.row - 1];
    if (
      cur && above && cur[0] === "+" && above[0] === "-" &&
      cur.slice(1) === above.slice(1)
    ) {
      b.spliceLines(b.row - 1, 2, [` ${cur.slice(1)}`], 0, b.col);
      this.splitRow = null;
    }
  }

  /** After an edit changed the cursor's hunk's line count (a `+` line added or
   * removed, a context line removed), grow or shrink that hunk header's counts
   * to match, so the diff stays well-formed and the deferred re-parse keeps
   * every body line in the hunk instead of dropping the overflow as plain text. */
  private adjustHunkCounts(oldDelta: number, newDelta: number): void {
    if (
      !this.source?.policy || !this.buffer || (oldDelta === 0 && newDelta === 0)
    ) {
      return;
    }
    const b = this.buffer;
    let h = Math.min(b.row, b.lines.length - 1);
    while (h >= 0 && !b.lines[h].startsWith("@@ ")) {
      if (/^(diff |--- |\+\+\+ )/.test(b.lines[h])) return; // not inside a hunk
      h--;
    }
    if (h < 0) return;
    const m = b.lines[h].match(
      /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/,
    );
    if (!m) return;
    const oldCount = Math.max(
      0,
      (m[2] !== undefined ? parseInt(m[2], 10) : 1) + oldDelta,
    );
    const newCount = Math.max(
      0,
      (m[4] !== undefined ? parseInt(m[4], 10) : 1) + newDelta,
    );
    b.lines[h] = `@@ -${m[1]},${oldCount} +${m[3]},${newCount} @@${m[5] ?? ""}`;
  }

  /** The first editable column on the cursor's line under the source's policy
   * (a diff), or null when the line cannot be edited. No policy → column 0. */
  private editStart(): number | null {
    const pol = this.source?.policy;
    if (!pol) return 0;
    return pol.editStart(this.buffer!.lines, this.buffer!.row);
  }

  /** Whether the cursor sits in an editable commit-message line — plain indented
   * text, edited without the diff's removed/added pairing. */
  private inMessageRow(): boolean {
    const pol = this.source?.policy;
    return !!pol && !!this.buffer &&
      pol.regionKind(this.buffer.lines, this.buffer.row) === "message";
  }

  /**
   * Gate an insert-like edit under the source's policy (a diff). Refuses a
   * multi-line insert (it would add unmarked lines) and a line that is not
   * editable; otherwise nudges the cursor past the diff marker and allows it. A
   * plain file (no policy) always passes.
   */
  private allowEdit(multiline: boolean, split = true): boolean {
    if (!this.source?.policy) return true;
    if (multiline) {
      this.message = MULTILINE_MSG;
      return false;
    }
    const b = this.buffer!;
    const start = this.editStart();
    if (start === null) {
      this.message = NOT_EDITABLE_MSG;
      return false;
    }
    if (b.col < start) b.place(b.row, start);
    if (split) this.prepareContextEdit();
    return true;
  }

  /** Gate a delete-forward edit (delete, M-d, C-k): refuse the diff marker and
   * a delete at end of line, which would join the next line — removing a line
   * is Backspace at its start instead. */
  private guardForwardEdit(): boolean {
    if (!this.source?.policy) return true;
    const b = this.buffer!;
    const start = this.editStart();
    if (start === null) {
      this.message = NOT_EDITABLE_MSG;
      return false;
    }
    if (b.col < start) b.place(b.row, start);
    if (b.col >= b.currentLineLength()) {
      this.message = JOIN_MSG;
      return false;
    }
    this.prepareContextEdit();
    return true;
  }

  /** Backspace under the source's policy: delete a character past the marker,
   * remove the whole line when its content is empty (an added line taken back),
   * else protect the marker. A plain file just deletes backward. */
  private handleBackspace(): void {
    const b = this.buffer!;
    if (!this.source?.policy) {
      b.deleteBackward();
      return this.afterEdit();
    }
    const start = this.editStart();
    if (start === null) {
      this.message = NOT_EDITABLE_MSG;
      return;
    }
    if (b.col > start) {
      this.prepareContextEdit();
      b.deleteBackward();
      return this.afterEdit();
    }
    if (b.currentLineLength() <= start && b.row > 0) {
      this.removeDiffLine(start);
      return this.afterEdit();
    }
    this.message = MARKER_MSG;
  }

  /** Remove the cursor's (empty-content) line, joining into the previous line
   * and stripping the marker the join carries over, then shrink the hunk header
   * by the side(s) the removed line counted on. */
  private removeDiffLine(markerLen: number): void {
    const b = this.buffer!;
    const marker = b.lines[b.row][0] ?? "";
    b.place(b.row, 0);
    b.deleteBackward(); // join into the previous line
    for (let i = 0; i < markerLen; i++) b.deleteForward(); // drop the marker
    this.adjustHunkCounts(
      marker === " " || marker === "-" ? -1 : 0,
      marker === " " || marker === "+" ? -1 : 0,
    );
  }

  /** Gate a backward word kill (M-Backspace): refuse reaching the marker. */
  private guardBackwardEdit(): boolean {
    if (!this.source?.policy) return true;
    const b = this.buffer!;
    const start = this.editStart();
    if (start === null) {
      this.message = NOT_EDITABLE_MSG;
      return false;
    }
    if (b.col <= start) {
      this.message = MARKER_MSG;
      return false;
    }
    this.prepareContextEdit();
    return true;
  }

  /** Gate a region kill (C-w): refuse a multi-line region or one that reaches
   * into the diff marker. */
  private guardRegionEdit(): boolean {
    if (!this.source?.policy) return true;
    const b = this.buffer!;
    const mark = b.mark;
    if (!mark) {
      this.message = "Set the mark first (Ctrl-Space).";
      return false;
    }
    if (mark.row !== b.row) {
      this.message = MULTILINE_MSG;
      return false;
    }
    const start = this.editStart();
    if (start === null) {
      this.message = NOT_EDITABLE_MSG;
      return false;
    }
    if (Math.min(b.col, mark.col) < start) {
      this.message = MARKER_MSG;
      return false;
    }
    this.prepareContextEdit();
    return true;
  }

  private afterMove(): void {
    this.ensureCursorVisible();
  }

  private afterEdit(): void {
    this.selectedIndex = null;
    this.collapseUnchangedPair();
    if (this.source && this.buffer) {
      const text = this.buffer.text();
      const lines = this.liveHighlight(text);
      if (lines) {
        // Re-highlight on every keystroke — correct for multi-line tokens, and a
        // fraction of a full parse because it skips the structure tree. The
        // structure (navigation, cross-references) is refreshed on the deferred
        // re-parse.
        this.currentDoc = { ...this.currentDoc, text, lines };
        this.needsReparse = true;
      } else {
        this.currentDoc = this.source.parse(text);
        this.needsReparse = false;
      }
    }
    this.clampScroll();
    this.ensureCursorVisible();
  }

  /** Take away a message that was set to go away on its own, once the driver has
   * left it up for its moment. Does nothing to a message that is not one of
   * those, so a later one is never cleared out from under itself. */
  expireMessage(): void {
    if (!this.transientMessage) return;
    this.transientMessage = false;
    this.message = "";
  }

  /** Live re-highlight `text` into rendered lines, or null when the source has
   * no live highlighter (then the caller does a full parse). Prefers the
   * incremental highlighter, created lazily and seeded with the current text so
   * the first keystroke is a full highlight and each later one is incremental. */
  private liveHighlight(text: string): readonly Line[] | null {
    if (this.highlighter) return this.highlighter.update(text);
    return this.source?.highlight?.(text) ?? null;
  }

  /** Run the deferred full re-parse, refreshing the structure tree and
   * cross-references after the per-keystroke re-highlights (which keep the lines
   * current but not the structure). The incremental highlighter is discarded so
   * the next edit re-seeds it from this authoritative parse. */
  reparse(): void {
    if (!this.source || !this.buffer || !this.needsReparse) return;
    this.currentDoc = this.source.parse(this.buffer.text());
    this.needsReparse = false;
    // Re-baseline the live highlighter from this authoritative parse while still
    // editing; drop it when leaving edit mode.
    if (this.cursorOn) this.seedHighlighter();
    else this.highlighter = undefined;
    this.clampScroll();
    this.ensureCursorVisible();
  }

  private cursorPage(dir: number): void {
    const b = this.buffer!;
    const step = Math.max(1, this.contentRows() - 1);
    b.place(b.row + dir * step, b.col);
    this.top = clamp(
      this.top + dir * step,
      0,
      maxTop(this.doc.lines.length, this.height),
    );
    this.ensureCursorVisible();
  }

  private ensureCursorVisible(): void {
    if (!this.buffer) return;
    const b = this.buffer;
    const rows = this.contentRows();
    if (b.row < this.top) this.top = b.row;
    else if (b.row >= this.top + rows) this.top = b.row - rows + 1;
    this.top = clamp(this.top, 0, maxTop(this.doc.lines.length, this.height));
    const cw = this.contentWidth();
    if (b.col < this.left) this.left = b.col;
    else if (b.col >= this.left + cw) this.left = b.col - cw + 1;
    this.left = clamp(this.left, 0, this.maxLineLen);
  }

  private contentWidth(): number {
    const guide = this.selectedNode() ? 1 : 0;
    return Math.max(1, this.width - this.gutterWidth() - guide);
  }

  /** Cycle the line-number gutter: off → input position → file/message line. */
  private cycleLineNumbers(): void {
    const order: LineNumberMode[] = ["off", "input", "file"];
    this.lineNumberMode =
      order[(order.indexOf(this.lineNumberMode) + 1) % order.length];
    const label = this.lineNumberMode === "off"
      ? "off"
      : this.lineNumberMode === "input"
      ? "input position"
      : "file / message line";
    this.message = `Line numbers: ${label}`;
  }

  /** The gutter width for the current mode: wide enough for the largest number
   * it shows (file lines can exceed the number of lines the diff spans). */
  private gutterWidth(): number {
    if (this.lineNumberMode === "off") return 0;
    const max = this.gutterNumbers().reduce<number>(
      (m, n) => n !== null && n > m ? n : m,
      0,
    );
    return Math.max(4, String(Math.max(1, max)).length + 1);
  }

  /** The number the gutter shows on each display row, or null for a blank
   * gutter there (a removed or structural diff line in file mode, or an
   * unmapped row). */
  private gutterNumbers(): (number | null)[] {
    const plan = this.foldPlan();
    const rows = plan.displayLines.length;
    const fileNums = this.lineNumberMode === "file"
      ? this.fileLineNumbers()
      : null;
    const out: (number | null)[] = new Array(rows);
    for (let r = 0; r < rows; r++) {
      const docLine = plan.displayToDoc(r);
      // "input" numbers, and "file" numbers for a non-diff view (where the input
      // is the file), are just the document line.
      out[r] = fileNums ? fileNums[docLine] ?? null : docLine + 1;
    }
    return out;
  }

  /** For a diff, each document line's underlying line: a context/added line's
   * new-file line, a commit-message line's position within the message, else
   * null. Null for a non-diff view (no distinct underlying file). Cached against
   * the document, since every frame draws the gutter and the map costs a parse
   * of the whole diff. */
  private fileLineNumbers(): (number | null)[] | null {
    if (this.fileLineCache?.doc !== this.currentDoc) {
      this.fileLineCache = {
        doc: this.currentDoc,
        value: this.computeFileLineNumbers(),
      };
    }
    return this.fileLineCache.value;
  }

  private computeFileLineNumbers(): (number | null)[] | null {
    if (!this.source?.isDiff) return null;
    const texts = this.currentDoc.lines.map((l) => l.text);
    const out: (number | null)[] = new Array(texts.length).fill(null);
    const model = parseDiff(this.currentDoc.text);
    if (model) {
      for (let i = 0; i < model.lines.length && i < out.length; i++) {
        const nl = model.lines[i].newLine;
        if (nl !== undefined) out[i] = nl + 1;
      }
    }
    for (const m of findCommitMessages(texts)) {
      for (let i = m.start; i <= m.end && i < out.length; i++) {
        out[i] = i - m.start + 1;
      }
    }
    return out;
  }

  private handleChord(key: Key): void {
    this.chord = null;
    this.message = "";
    if (key.name === "ctrl-s") this.requestSave();
    else if (key.name === "ctrl-c") this.requestQuit();
    else if (key.name === "ctrl-f") this.openFilePicker();
    else this.message = `C-x ${key.name}: unbound`;
  }

  private requestSave(): boolean {
    if (!this.source || !this.buffer) {
      this.message = "Nothing to save.";
      return false;
    }
    if (!this.source.editable) {
      this.message = this.source.reason ?? "This view is read-only.";
      return false;
    }
    const baseline = this.buffer.baseline();
    const current = this.buffer.text();
    // A changed commit message rewrites git history, so confirm before saving.
    const amend = this.source.pendingAmend?.(baseline, current) ?? null;
    if (amend && !this.amendConfirmed) {
      if (amend.subject.trim() === "") {
        this.message = "Refusing to amend: the commit message would be empty.";
        return false;
      }
      this.mode = "amendPrompt";
      this.focusDefaultButton();
      this.message = "";
      return false;
    }
    try {
      // Amend the commit before writing files: if the amend fails (an empty
      // message, a rejecting hook, HEAD moved) nothing is written to disk, so a
      // failed save never leaves the files half-written.
      const amended = amend
        ? this.source.amendCommit!(baseline, current)
        : null;
      const saved = this.source.save(current);
      this.message = amended
        ? (/^No(thing)?\b/.test(saved) ? amended : `${saved}; ${amended}`)
        : saved;
      this.buffer.commitSaved();
      return true;
    } catch (e) {
      this.message = `Save failed: ${e instanceof Error ? e.message : e}`;
      return false;
    } finally {
      this.amendConfirmed = false;
    }
  }

  private applyAmendButton(button: DialogButton): void {
    if (button.hotkey === "y") {
      this.amendConfirmed = true;
      const ok = this.requestSave();
      this.mode = "normal";
      this.editedFiles = [];
      if (ok && this.savePromptThen === "quit") this.quit = true;
      this.savePromptThen = null;
    } else if (button.kind === "cancel") {
      this.mode = "normal";
      this.amendConfirmed = false;
      this.savePromptThen = null;
      this.editedFiles = [];
      this.message = "Save cancelled — the commit was not amended.";
    }
  }

  private requestQuit(): void {
    if (this.buffer?.dirty()) {
      // A quit signal can arrive with a peek overlay still open; the modal save
      // prompt replaces it rather than drawing over it.
      this.overlay = null;
      this.overlayScroll = 0;
      this.overlayStack = [];
      this.mode = "savePrompt";
      this.savePromptThen = "quit";
      this.editedFiles = this.computeEditedFiles();
      this.focusDefaultButton();
      this.message = "";
    } else {
      this.quit = true;
    }
  }

  /** The files a save would write — just those an edit actually touched, not
   * every file a diff spans. A diff source reports this exactly (an empty list
   * when only the commit message changed); a plain file falls back to its one
   * label. */
  private computeEditedFiles(): string[] {
    if (!this.source || !this.buffer) return [];
    const labels = this.source.dirtyLabels?.(
      this.buffer.baseline(),
      this.buffer.text(),
    );
    if (labels !== undefined) return labels;
    return this.source.label ? [this.source.label] : [];
  }

  /**
   * An interrupt (SIGINT) arrived. With unsaved edits and no prompt already up,
   * raise the save prompt and return true so the driver keeps running and lets
   * the user answer it. Otherwise return false: nothing to save, or a second
   * interrupt during the prompt, so the driver should terminate.
   */
  requestQuitFromSignal(): boolean {
    if (this.mode === "savePrompt") return false;
    const willPrompt = this.buffer?.dirty() ?? false;
    this.requestQuit();
    return willPrompt;
  }

  /** Keys while a modal prompt (save / amend / revert) is up. Tab and Shift-Tab
   * move the focus ring between buttons, wrapping around; Space and Enter
   * activate the focused button; Esc activates the cancel button; a button's
   * shortcut letter activates it directly. Any other key leaves the prompt up. */
  private handleDialogKey(key: Key): void {
    // Reached only from the prompt modes, each of which builds a dialog with at
    // least two buttons, so the dialog is present and its row is non-empty.
    const dialog = this.promptDialog()!;
    const buttons = dialog.buttons;
    const n = buttons.length;

    // Tab moves the ring forward, Shift-Tab back, both wrapping around. From no
    // focus (-1) Tab lands on the first button and Shift-Tab on the last.
    if (key.name === "tab") {
      this.dialogFocus = this.dialogFocus < 0 ? 0 : (this.dialogFocus + 1) % n;
      return;
    }
    if (key.name === "shift-tab") {
      this.dialogFocus = this.dialogFocus < 0
        ? n - 1
        : (this.dialogFocus - 1 + n) % n;
      return;
    }

    let index = -1;
    if (key.name === "enter" || key.name === "space" || key.char === " ") {
      // The clamped focus the dialog was drawn with, so Enter always activates
      // the highlighted button. -1 means nothing is focused: a no-op.
      index = dialog.focus ?? -1;
    } else if (key.name === "escape") {
      index = buttons.findIndex((b) => b.kind === "cancel");
    } else {
      const k = (key.char ?? key.name).toLowerCase();
      index = buttons.findIndex((b) => b.hotkey.toLowerCase() === k);
    }
    if (index < 0 || index >= n) return; // an unbound key leaves the prompt up
    this.activateButton(dialog, index);
  }

  /** Run a prompt button's action, first capturing the frame that shows it
   * pushed so the driver can play the press before the result appears. The
   * pressed button is drawn focused as well, so a shortcut-key press shows it
   * highlighted rather than leaving the highlight on whatever Tab last chose. */
  private activateButton(dialog: DialogState, index: number): void {
    this.dialogFocus = index;
    this.pendingPush = {
      doc: this.displayDoc(),
      view: {
        ...this.view(),
        dialog: { ...dialog, focus: index, pushed: index },
      },
    };
    const button = dialog.buttons[index];
    if (this.mode === "savePrompt") this.applySaveButton(button);
    else if (this.mode === "amendPrompt") this.applyAmendButton(button);
    else if (this.mode === "revertPrompt") this.applyRevertButton(button);
  }

  private applySaveButton(button: DialogButton): void {
    if (button.hotkey === "s") {
      const ok = this.requestSave();
      // The save may need to confirm a commit amend first; leave that prompt up
      // (keeping the quit intent) instead of forcing back to normal mode.
      if (this.mode === "amendPrompt") return;
      this.mode = "normal";
      this.editedFiles = [];
      if (ok && this.savePromptThen === "quit") this.quit = true;
      this.savePromptThen = null;
    } else if (button.hotkey === "d") {
      this.mode = "normal";
      this.editedFiles = [];
      if (this.savePromptThen === "quit") this.quit = true;
      this.savePromptThen = null;
    } else if (button.kind === "cancel") {
      this.mode = "normal";
      this.savePromptThen = null;
      this.editedFiles = [];
      this.message = "Cancelled";
    }
  }

  /** Open the revert prompt (Ctrl-R while editing). A diff offers only the
   * scopes that apply where the cursor is — the hunk and/or file it is in, or
   * the commit message it is in — plus all; a plain file reverts wholesale. */
  private openRevertPrompt(): void {
    if (!this.buffer?.dirty()) {
      this.message = "Nothing to revert.";
      return;
    }
    this.mode = "revertPrompt";
    this.focusDefaultButton();
    this.message = "";
  }

  /** Which revert scopes apply at the cursor: whether it sits in a hunk, in a
   * file, and in an editable commit message. Derived from the current buffer
   * text so it matches what the revert itself finds. */
  private revertScopesAt(): {
    chunk: boolean;
    file: boolean;
    message: boolean;
  } {
    const row = this.buffer!.row;
    const message = this.inMessageRow();
    let file = false;
    let chunk = false;
    const model = parseDiff(this.buffer!.text());
    const f = model?.files.find((f) => row >= f.headerLine && row <= f.endLine);
    if (f) {
      file = true;
      chunk = f.hunks.some((h) => row >= h.headerLine && row <= h.endLine);
    }
    return { chunk, file, message };
  }

  private applyRevertButton(button: DialogButton): void {
    // The dialog only offers the scopes that apply where the cursor sits, so a
    // scope button that reached here is always valid.
    let scope: RevertScope | null = null;
    switch (button.hotkey) {
      case "h":
        scope = "chunk";
        break;
      case "f":
        scope = "file";
        break;
      case "m":
        scope = "message";
        break;
      case "a": // a diff's all
      case "y": // a plain file's single scope
        scope = "all";
        break;
    }
    if (scope) {
      this.performRevert(scope);
      this.mode = "normal";
    } else if (button.kind === "cancel") {
      this.message = "Cancelled";
      this.mode = "normal";
    }
  }

  /** Restore the chosen scope to its original form, keeping the dirty baseline
   * so any remaining edits still count. */
  private performRevert(scope: RevertScope): void {
    if (!this.source?.revert || !this.buffer) {
      this.message = "Revert isn't available here.";
      return;
    }
    const result = this.source.revert(
      this.buffer.baseline(),
      this.buffer.text(),
      this.buffer.row,
      scope,
    );
    if (!result) {
      this.message = "Nothing to revert there.";
      return;
    }
    this.buffer.setText(result.text, result.cursorLine, 0);
    this.splitRow = null;
    this.snapCursorToEditable();
    this.currentDoc = this.source.parse(result.text);
    this.needsReparse = false;
    if (this.cursorOn) this.seedHighlighter();
    this.clampScroll();
    this.ensureCursorVisible();
    this.message = `Reverted ${
      scope === "all" ? "all edits" : "the " + scope
    }.`;
  }

  /** Move the cursor down to the first editable line at or after it, so it does
   * not sit on a non-editable header after a revert restores a hunk or file. */
  private snapCursorToEditable(): void {
    const b = this.buffer;
    const pol = this.source?.policy;
    if (!b || !pol) return;
    while (
      b.row < b.lines.length - 1 && pol.editStart(b.lines, b.row) === null
    ) {
      b.place(b.row + 1, 0);
    }
  }

  /** Reveal more of the underlying file around a hunk (Ctrl-L). When the text
   * cursor is active the hunk is the one it sits in and the view follows the
   * cursor; in pager mode it is the hunk at the middle of the screen, and the
   * view holds the far edge of that hunk still so the revealed lines open a gap
   * in front of the user. The extra context is applied to the baseline too, so
   * it does not count as an unsaved edit. */
  private performExpand(): void {
    if (!this.source?.expandContext || !this.buffer) {
      this.message = "Expanding context isn't available here.";
      return;
    }
    let refLine: number;
    let up: boolean | undefined;
    if (this.cursorOn) {
      refLine = this.buffer.row; // the cursor names a point, not an edge
    } else {
      const offer = this.expandOffer();
      // Ctrl-L is not offered in any of these, so it changes nothing and there
      // is nothing to leave the reason standing next to: say why, and take it
      // away again once it has been read.
      if (offer === null) {
        this.message = "Move to a hunk's edge, then Ctrl-L to expand it.";
        this.transientMessage = true;
        return;
      }
      if ("blocked" in offer) {
        this.message = offer.blocked === "top"
          ? "Top of file."
          : offer.blocked === "bottom"
          ? "Bottom of file."
          : "No more context to show.";
        this.transientMessage = true;
        return;
      }
      refLine = offer.line;
      up = offer.up;
    }
    const r = this.source.expandContext(
      this.buffer.text(),
      this.buffer.baseline(),
      refLine,
      up,
    );
    if (!r) {
      this.message = "No more context to show.";
      return;
    }
    // The node the selection denotes, captured before the reparse renumbers the
    // structure tree under it. The pinned line's row is captured too, before the
    // fold plan (which the reparse invalidates) changes.
    const selected = this.cursorOn ? null : this.selectedNode();
    // Where a line of the old text lands in the new one.
    const moved = (n: number) =>
      n + (n >= r.insertedAt ? r.inserted : 0) -
      (r.removedAt !== null && n > r.removedAt ? 1 : 0);
    // The line held still on screen: the one just outside the edge the revealed
    // lines go in at, so they open a gap on the hunk's side of it. Expanding
    // upwards holds the hunk's header and pushes the body down; expanding
    // downwards holds what follows the hunk and lifts the body up. A join takes
    // that very header away, so what is held is the line the other side of it —
    // the neighbouring hunk's body, which is what is left to hold on to.
    const pinDoc = r.removedAt !== null
      ? (r.up ? r.removedAt - 1 : r.removedAt + 1)
      : (r.up ? r.insertedAt - 1 : r.insertedAt);
    const pinRow = this.toDisplay(pinDoc) - this.top;
    const col = this.cursorOn ? this.buffer.col : 0;
    this.buffer.setBaseline(r.baseline);
    this.buffer.setText(r.text, r.cursorLine, col);
    this.splitRow = null;
    this.currentDoc = this.source.parse(r.text);
    this.needsReparse = false;
    if (this.cursorOn) {
      this.seedHighlighter();
      this.clampScroll();
      this.ensureCursorVisible();
      this.reportReveal(r);
      return;
    }
    // Pager mode: re-point the selection at the same node (its line moved), and
    // put the pinned line back on the row it was on.
    this.reselectAfterExpand(selected, moved);
    this.top = this.toDisplay(moved(pinDoc)) - pinRow;
    this.clampScroll();
    // The revealed lines fill the gap the insertion point opened, so the driver
    // can walk them in from the held edge. A join is drawn in one step instead:
    // its frames would stand the two hunks' bodies next to each other before the
    // lines that join them had arrived, showing a file that reads nothing like
    // the one on disk.
    this.pendingReveal = r.removedAt !== null ? null : {
      row: this.toDisplay(r.insertedAt),
      count: r.inserted,
      up: r.up,
    };
    this.reportReveal(r);
  }

  /** Say what a reveal showed: which way it reached, and which lines of the file
   * came back with it. Naming the lines is the point — one run of context looks
   * like any other, and the file's own numbers are what tie them to it. A reveal
   * that closed the last gap between two hunks says so too, since a header
   * disappearing is otherwise left to be puzzled over. */
  private reportReveal(r: ExpandResult): void {
    const { from, to } = r.revealed;
    const lines = from === to ? `line ${from}` : `lines ${from}-${to}`;
    const where = r.up ? "above" : "below";
    this.message = r.removedAt !== null
      ? `Showing ${lines} ${where} — the two hunks are now one.`
      : `Showing ${lines} ${where} the hunk.`;
    this.transientMessage = true;
  }

  /** After a pager-mode expand rebuilds the structure tree, point the selection
   * back at the same node, at wherever `moved` puts its line. Cleared when the
   * node can no longer be found — a join takes one of the two hunks away, and
   * there is nothing to point at. A hunk is matched on its line alone: only one
   * hunk starts at a given header line, and its label (the `@@` counts) changes
   * as the hunk grows; other kinds keep the label, which is stable and tells
   * apart nodes sharing a start line. */
  private reselectAfterExpand(
    node: StructureNode | null,
    moved: (line: number) => number,
  ): void {
    if (!node) return;
    const startLine = moved(node.startLine);
    const idx = this.doc.flatStructure.findIndex((n) =>
      n.startLine === startLine && n.kind === node.kind &&
      (node.kind === "hunk" || n.label === node.label)
    );
    this.selectedIndex = idx >= 0 ? idx : null;
  }

  /** Whether a node is on screen: its display rows overlap the viewport, and it
   * is not inside a collapsed file. A collapsed file's inner lines all map to
   * its summary row, which overlaps the viewport whenever that row is shown, so
   * the hidden range is excluded by its document extent instead. */
  private nodeOnScreen(node: StructureNode): boolean {
    const inHiddenFile = this.foldFiles().some((f) =>
      this.collapsed.has(f.index) &&
      node.startLine > f.headerLine && node.startLine <= f.endLine
    );
    if (inHiddenFile) return false;
    return this.toDisplay(node.endLine) >= this.top &&
      this.toDisplay(node.startLine) < this.top + this.contentRows();
  }

  /** The middle of the content on screen, as a display row. The rows the
   * content occupies, rather than the rows the terminal has: a document shorter
   * than the screen ends part-way down it, and the rows past its end are not
   * somewhere the user is looking. */
  private middleRow(): number {
    const last = Math.min(this.top + this.contentRows(), this.displayCount()) -
      1;
    return Math.floor((this.top + last) / 2);
  }

  /** How much context each hunk can still reveal, keyed by its header line.
   * Cached against the document, which the source rebuilds on every expand. */
  private expandRoom(): ReadonlyMap<number, HunkRoom> {
    if (this.roomCache?.doc !== this.currentDoc) {
      this.roomCache = {
        doc: this.currentDoc,
        room: this.source?.expandRoom?.(this.currentDoc.text) ?? new Map(),
      };
    }
    return this.roomCache.room;
  }

  /** Every hunk edge the user can see: the row it sits on, the line to expand
   * from, which way that grows, and what the file offers there. A hunk with
   * neither edge on screen offers nothing to aim at — its boundaries are off in
   * the dark, and growing one would happen where it could not be watched. */
  private visibleEdges(): {
    row: number;
    line: number;
    up: boolean;
    room: HunkRoom;
  }[] {
    const room = this.expandRoom();
    const rows = this.contentRows();
    const onScreen = (row: number) => row >= this.top && row < this.top + rows;
    const out = [];
    for (const h of this.doc.flatStructure) {
      if (h.kind !== "hunk" || !this.nodeOnScreen(h)) continue;
      const r = room.get(h.startLine);
      if (!r) continue;
      // The top edge is the header the revealed lines land under; the bottom is
      // the last body line they land after.
      for (
        const [line, up] of [[h.startLine, true], [h.endLine, false]] as const
      ) {
        const row = this.toDisplay(line);
        if (onScreen(row)) out.push({ row, line, up, room: r });
      }
    }
    return out;
  }

  /** The hunk edge Ctrl-L acts on in pager mode: the visible one nearest the
   * middle of the screen, or nearest a selected node when one sits in a hunk.
   * Null when no edge is on screen. The edge is returned whether or not it has
   * room, so that the offer of Ctrl-L and what Ctrl-L does agree. */
  private expandEdge():
    | { line: number; up: boolean; room: HunkRoom }
    | null {
    const edges = this.visibleEdges();
    if (edges.length === 0) return null;
    // A selected node sitting in a hunk aims at that hunk, and its own row is
    // what the edges are measured from: the user picked a place to look.
    const sel = this.selectedNode();
    const own = sel && this.nodeOnScreen(sel)
      ? edges.filter((e) =>
        this.doc.flatStructure.some((h) =>
          h.kind === "hunk" && h.startLine <= e.line && e.line <= h.endLine &&
          sel.startLine >= h.startLine && sel.startLine <= h.endLine
        )
      )
      : [];
    const from = own.length > 0
      ? this.toDisplay(sel!.startLine)
      : this.middleRow();
    const pool = own.length > 0 ? own : edges;
    // Distance in display rows: a collapsed file stands on one row, and the
    // lines it hides are not distance the eye travels.
    let best = pool[0];
    for (const e of pool) {
      if (Math.abs(e.row - from) < Math.abs(best.row - from)) best = e;
    }
    return { line: best.line, up: best.up, room: best.room };
  }

  /** Whether Ctrl-L would reveal anything from where the user is looking, which
   * is what the status bar offers it on. Edit mode aims with the cursor rather
   * than the screen, and keeps its own offer. */
  private canExpand(): boolean {
    if (this.cursorOn || !this.source?.expandContext) return false;
    const offer = this.expandOffer();
    return offer !== null && !("blocked" in offer);
  }

  /** Whether Ctrl-L would reveal anything, and what stops it when it would not.
   * Drives both the status bar's offer of Ctrl-L and the key itself. */
  private expandOffer():
    | { line: number; up: boolean }
    | { blocked: "top" | "bottom" | "hunk" }
    | null {
    const edge = this.expandEdge();
    if (!edge) return null;
    if ((edge.up ? edge.room.up : edge.room.down) > 0) {
      return { line: edge.line, up: edge.up };
    }
    if (edge.up) return { blocked: edge.room.atFileTop ? "top" : "hunk" };
    return { blocked: edge.room.atFileBottom ? "bottom" : "hunk" };
  }

  // --- file picker (C-x C-f) -------------------------------------------------

  private openFilePicker(): void {
    if (!this.files) {
      this.message = "Opening files isn't available here.";
      return;
    }
    this.cursorOn = false;
    // Opening the picker drops the text cursor, and cancelling it returns to
    // navigation, which reads the structure tree. Refresh it here as leaving
    // edit mode by Esc does, so that return lands on a current tree.
    this.reparse();
    this.overlay = null;
    this.overlayStack = [];
    this.pickerDir = this.pickerStartDir();
    this.pickerFilter = "";
    this.pickerSel = 0;
    this.overlayScroll = 0;
    this.mode = "filePicker";
    this.refreshPicker();
  }

  /** Open at the current file's directory, else the gateway's cwd. */
  private pickerStartDir(): string {
    const path = this.source?.path;
    if (path && this.files) return this.files.parent(path);
    return this.files!.cwd();
  }

  /** Re-list the current directory, filtered by what has been typed. */
  private refreshPicker(): void {
    if (!this.files) return;
    const all = this.files.list(this.pickerDir) ?? [];
    const f = this.pickerFilter.toLowerCase();
    const matched = all.filter((e) => e.name.toLowerCase().includes(f));
    matched.sort((a, b) =>
      a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1
    );
    // A ".." entry to step up, offered when not narrowing by a filter.
    this.pickerEntries = this.pickerFilter.length === 0
      ? [{ name: "..", isDir: true }, ...matched]
      : matched;
    this.pickerSel = clamp(
      this.pickerSel,
      0,
      Math.max(0, this.pickerEntries.length - 1),
    );
    this.ensurePickerVisible();
  }

  private ensurePickerVisible(): void {
    const innerH = overlayBox(this.width, this.height).innerH;
    if (this.pickerSel < this.overlayScroll) {
      this.overlayScroll = this.pickerSel;
    } else if (this.pickerSel >= this.overlayScroll + innerH) {
      this.overlayScroll = this.pickerSel - innerH + 1;
    }
  }

  private handleFilePicker(key: Key): void {
    this.message = "";
    const last = Math.max(0, this.pickerEntries.length - 1);
    switch (key.name) {
      case "escape":
        this.mode = "normal";
        this.overlayScroll = 0;
        this.message = "Cancelled";
        return;
      case "down":
      case "ctrl-n":
        this.pickerSel = clamp(this.pickerSel + 1, 0, last);
        return this.ensurePickerVisible();
      case "up":
      case "ctrl-p":
        this.pickerSel = clamp(this.pickerSel - 1, 0, last);
        return this.ensurePickerVisible();
      case "pagedown":
        this.pickerSel = clamp(this.pickerSel + 10, 0, last);
        return this.ensurePickerVisible();
      case "pageup":
        this.pickerSel = clamp(this.pickerSel - 10, 0, last);
        return this.ensurePickerVisible();
      case "backspace":
        if (this.pickerFilter.length > 0) {
          this.pickerFilter = this.pickerFilter.slice(0, -1);
          this.pickerSel = 0;
          this.refreshPicker();
        } else {
          this.pickerUp();
        }
        return;
      case "tab":
      case "enter":
        this.activatePicked();
        return;
    }
    if (key.char && key.char >= " " && !key.ctrl) {
      this.pickerFilter += key.char;
      this.pickerSel = 0;
      this.refreshPicker();
    }
  }

  private pickerUp(): void {
    if (!this.files) return;
    this.pickerDir = this.files.parent(this.pickerDir);
    this.pickerFilter = "";
    this.pickerSel = 0;
    this.overlayScroll = 0;
    this.refreshPicker();
  }

  /** Act on the highlighted entry: step up, descend a directory, or open a
   * file. With nothing highlighted, treat the typed text as a filename. */
  private activatePicked(): void {
    if (!this.files) return;
    const entry = this.pickerEntries[this.pickerSel];
    if (!entry) {
      if (this.pickerFilter.length > 0) {
        this.openPickedFile(this.files.join(this.pickerDir, this.pickerFilter));
      }
      return;
    }
    if (entry.name === "..") {
      this.pickerUp();
      return;
    }
    const target = this.files.join(this.pickerDir, entry.name);
    if (entry.isDir) {
      this.pickerDir = target;
      this.pickerFilter = "";
      this.pickerSel = 0;
      this.overlayScroll = 0;
      this.refreshPicker();
    } else {
      this.openPickedFile(target);
    }
  }

  /** Replace the session's buffer/source/document with the chosen file. Refuses
   * when the current buffer has unsaved edits, to avoid losing them. */
  private openPickedFile(absPath: string): void {
    if (!this.files) return;
    if (this.buffer?.dirty()) {
      this.mode = "normal";
      this.message =
        "Save or discard your changes before opening another file.";
      return;
    }
    const opened = this.files.open(absPath);
    if (!opened) {
      this.mode = "normal";
      this.message = `Cannot open ${absPath}`;
      return;
    }
    this.source = opened.source;
    this.buffer = new EditBuffer(opened.text);
    this.splitRow = null;
    this.highlighter = undefined; // the old highlighter was for the previous file
    this.clearFolds(); // the previous file's fold indices do not carry over
    this.currentDoc = opened.source.parse(opened.text);
    this.semantics = undefined; // the old service was for the previous file
    this.mode = "normal";
    this.cursorOn = false;
    this.overlay = null;
    this.overlayScroll = 0;
    this.overlayStack = [];
    this.selectedIndex = null;
    this.query = "";
    this.matches = [];
    this.currentMatch = 0;
    this.top = 0;
    this.left = 0;
    this.message = `Opened ${opened.source.label ?? absPath}`;
  }

  private pickerOverlay(): OverlayState {
    const lines: Line[] = this.pickerEntries.map((e) => {
      const text = e.isDir ? `${e.name}/` : e.name;
      const cls: TokenClass = e.isDir ? "builderCall" : "plain";
      return { text, spans: [{ col: 0, text, cls }] };
    });
    if (lines.length === 0) {
      const text = "(no matching files)";
      lines.push({ text, spans: [{ col: 0, text, cls: "comment" }] });
    }
    const name = this.files?.base(this.pickerDir) || this.pickerDir;
    return {
      title: `Open file — ${name}`,
      lines,
      scroll: this.overlayScroll,
      footer: "↑/↓ select · enter open · ⌫ up · esc cancel",
      selectedLine: this.pickerEntries.length > 0 ? this.pickerSel : undefined,
    };
  }

  private navigateTree(
    step: (flat: readonly StructureNode[], idx: number) => number,
  ): void {
    if (this.doc.flatStructure.length === 0) {
      this.message = "No structure detected";
      return;
    }
    // Navigation walks only the nodes that are on screen: a collapsed file's
    // interior (its hunks and code) is skipped, leaving just the file itself.
    const nav = this.navigableIndices();
    const navNodes = nav.map((i) => this.doc.flatStructure[i]);
    if (this.selectedIndex === null) {
      this.selectNode(nav[this.viewportNodeIndex(navNodes)]);
      return;
    }
    let cur = nav.indexOf(this.selectedIndex);
    if (cur < 0) cur = this.reselectAfterCollapse(navNodes); // hidden by a fold
    this.selectNode(nav[step(navNodes, cur)]);
  }

  /** The full-flatStructure indices navigation may land on: every node except
   * the interior of a collapsed file — its `section` node stays (it represents
   * the collapsed file), its descendants are dropped. */
  private navigableIndices(): number[] {
    const flat = this.doc.flatStructure;
    if (this.collapsed.size === 0) return flat.map((_, i) => i);
    const hidden = this.foldFiles().filter((f) => this.collapsed.has(f.index));
    const out: number[] = [];
    for (let i = 0; i < flat.length; i++) {
      const n = flat[i];
      const file = hidden.find((f) =>
        n.startLine >= f.headerLine && n.startLine <= f.endLine
      );
      // Keep the file's own section node; drop everything inside it.
      if (file && !(n.kind === "section" && n.startLine === file.headerLine)) {
        continue;
      }
      out.push(i);
    }
    return out;
  }

  /** Where to resume navigation when the selected node was folded away: the
   * navigable `section` node whose range contains the old selection. */
  private reselectAfterCollapse(navNodes: readonly StructureNode[]): number {
    const sel = this.doc.flatStructure[this.selectedIndex!];
    const idx = navNodes.findIndex((n) =>
      n.kind === "section" && sel.startLine >= n.startLine &&
      sel.startLine <= n.endLine
    );
    return idx >= 0 ? idx : this.viewportNodeIndex(navNodes);
  }

  /** The node to select when navigation starts with none selected: the first
   * node whose start sits on screen, else the node enclosing the viewport top,
   * else the first. Works in display rows, since a collapsed file's document
   * lines are not a contiguous on-screen span. */
  private viewportNodeIndex(nodes: readonly StructureNode[]): number {
    const bottom = this.top + this.contentRows() - 1;
    for (let i = 0; i < nodes.length; i++) {
      const row = this.toDisplay(nodes[i].startLine);
      if (row >= this.top && row <= bottom) return i;
    }
    const enclosing = nodeAtLine(nodes, this.toDoc(this.top));
    return enclosing >= 0 ? enclosing : 0;
  }
}

function isArrowName(name: string): boolean {
  return name === "up" || name === "down" || name === "left" ||
    name === "right";
}

export function helpOverlay(): {
  title: string;
  info: Line[];
  mode: "info";
  targets: readonly CardTarget[];
  cardSel: number;
  staticFooter: string;
} {
  const rows: Array<[string, string]> = [
    ["Scrolling", ""],
    ["  K / J", "line up / down"],
    ["  H / L", "scroll left / right"],
    ["  ↑ ↓ ← →", "scroll / pan the view"],
    ["  ⌥↑ ⌥↓ ⌥← ⌥→", "scroll / pan while editing"],
    ["  Space / B", "page down / up"],
    ["  ^D / ^U", "half page down / up"],
    ["  g / G", "top / bottom"],
    ["", ""],
    ["Search", ""],
    ["  /", "search (smartcase, incremental)"],
    ["  n / N", "next / previous match"],
    ["", ""],
    ["Diff files", ""],
    ["  f", "hide / show the file under the cursor (collapse to a summary)"],
    ["  F / E", "hide all files / show all files"],
    ["  T", "hide test and test-support files"],
    ["", ""],
    ["Structure tree", ""],
    ["  W / S", "previous / next sibling (W → parent, S → out, at ends)"],
    ["  A / D", "parent / first child"],
    ["  Tab / ⇧Tab", "next / previous node (depth-first)"],
    ["  Z", "centre selected node"],
    ["  ^L", "diff: reveal more of the file at the middle of the view"],
    ["  Esc", "clear selection / search"],
    ["", ""],
    ["Editing (a file or a diff)", ""],
    ["  e", "enter edit mode (reveal the text cursor)"],
    ["  ↑ ↓ ← →", "move the text cursor   ·   Esc leaves edit mode"],
    ["  ^A ^E  ⌥F ⌥B", "line start / end   ·   word forward / back"],
    ["  ^K ^Y  ^W ^Space", "kill line / yank   ·   kill region / set mark"],
    ["  ⌥L ⌥U ⌥C", "lower / upper / capitalise word"],
    ["  ^S", "search from the cursor (Enter lands there, ^S steps)"],
    ["  ^R", "revert: a diff's hunk / file / all, or a file's edits"],
    ["  ^L", "diff: reveal more of the file around the cursor's hunk"],
    ["  F3  ^X^S", "save to disk"],
    ["  ^X^F", "open another file"],
    ["", ""],
    ["Info card (Enter on a node)", ""],
    ["  Enter", "open the reference — or expand a “… N more” line"],
    ["  Esc", "back to the card you came from (or close)"],
    ["  Z", "close & centre the main view on the target"],
    ["  Tab", "toggle info card ⇄ source"],
    ["  t", "look up a definition by name"],
    ["", ""],
    ["View", ""],
    ["  #", "line numbers: off / input position / file or message line"],
    ["  C", "cycle non-printables: pictures / ANSI colour / hidden"],
    ["  ?", "this help   ·   Q  quit"],
  ];
  const info: Line[] = rows.map(([k, v]) => {
    const text = v ? `${k.padEnd(22)} ${v}` : k;
    const spans = v
      ? [
        { col: 0, text: k.padEnd(22), cls: "builderCall" as TokenClass },
        { col: 22, text: ` ${v}`, cls: "plain" as TokenClass },
      ]
      : [{ col: 0, text: k, cls: "sectionHeader" as TokenClass }];
    return { text, spans };
  });
  return {
    title: "cf view — keys",
    info,
    mode: "info",
    targets: [],
    cardSel: -1,
    staticFooter: "↑/↓ scroll · esc / q close",
  };
}
