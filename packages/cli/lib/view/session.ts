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
  nodeForViewport,
  scrollToAnchor,
  treeChild,
  treeNextSibling,
  treeParent,
  treePreOrderNext,
  treePreOrderPrev,
  treePrevSibling,
} from "./actions.ts";
import { buildPeekCard, type CardTarget } from "./card.ts";
import type { Semantics } from "./semantics.ts";
import { EditBuffer } from "./editbuffer.ts";
import type { EditableSource, RevertScope } from "./editsource.ts";
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

export class Session {
  private currentDoc: Document;
  private color: boolean;
  private showLineNumbers: boolean;

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
  private semantics?: Semantics;
  quit = false;
  /** An edit patched only the changed lines for speed; a full re-parse (for
   * structure, cross-references, and multi-line token colours) is owed. The
   * driver runs it on a short idle, so typing stays responsive. */
  needsReparse = false;

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
  /** What the active save prompt does on confirm. */
  private savePromptThen: "quit" | null = null;
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
    this.showLineNumbers = options.showLineNumbers;
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
      }
      : null;
    return {
      top: this.top,
      left: this.left,
      width: this.width,
      height: this.height,
      color: this.color,
      showLineNumbers: this.showLineNumbers,
      selected: this.selectedNode(),
      matches: this.query.length > 0 ? this.matches : null,
      currentMatch: this.currentMatch,
      message: this.message,
      inputLine: this.mode === "search"
        ? `/${this.input}`
        : this.mode === "deflookup"
        ? `definition: ${this.input}`
        : this.mode === "savePrompt" || this.mode === "revertPrompt"
        ? this.message
        : this.mode === "filePicker"
        ? `find file: ${this.files?.join(this.pickerDir, this.pickerFilter)}`
        : null,
      overlay: ov,
      cursor: this.cursorOn && this.buffer
        ? { line: this.buffer.row, col: this.buffer.col }
        : null,
      editHint: this.cursorOn ? this.editHint() : null,
      canExpand: !this.cursorOn && !!this.source?.expandContext,
      notice: this.mode === "savePrompt" ? this.noticeLines() : null,
    };
  }

  /** The edit-mode key hints for the status line. */
  private editHint(): string {
    const parts = ["esc done", "^s search", "^r revert"];
    if (this.source?.policy) parts.push("^l expand");
    parts.push("^x^s save", "^x^f open");
    return `editing — ${parts.join(" · ")}`;
  }

  /** The files a save would write, listed above the quit prompt — only when
   * more than one, since a single file is already named in the prompt itself. */
  private noticeLines(): string[] | null {
    if (this.editedFiles.length <= 1) return null;
    const max = 6;
    const head = `${this.editedFiles.length} files with changes:`;
    const shown = this.editedFiles.slice(0, max).map((f) => `  ${f}`);
    if (this.editedFiles.length > max) {
      shown.push(`  … and ${this.editedFiles.length - max} more`);
    }
    return [head, ...shown];
  }

  handleKey(key: Key): void {
    if (this.mode === "savePrompt") {
      this.handleSavePrompt(key);
      return;
    }
    if (this.mode === "revertPrompt") {
      this.handleRevertPrompt(key);
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
    this.top = clamp(this.top, 0, maxTop(this.doc.lines.length, this.height));
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
    // scroll is left untouched for the same reason.
    this.top = scrollToAnchor(
      node.startLine,
      this.top,
      this.height,
      this.doc.lines.length,
    );
    this.message = "";
  }

  private openPeek(node: StructureNode): void {
    const card = buildPeekCard(this.doc, node, this.semantics);
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
    parts.push("esc close");
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
      staticFooter: "↑/↓ scroll · esc close",
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

  /** Jump the main view to a card target, selecting the relevant node. */
  private jumpToTarget(target: CardTarget): void {
    this.overlay = null;
    this.overlayScroll = 0;
    let idx = this.findTargetIndex(target);
    if (idx < 0) idx = nodeAtLine(this.doc.flatStructure, target.destLine);
    this.selectedIndex = idx >= 0 ? idx : null;
    const node = idx >= 0 ? this.doc.flatStructure[idx] : null;
    // Frame the whole node (centred if it fits, else its top ~1/10 down). When
    // no node resolves, frame the single destination line.
    this.top = node
      ? frameTop(
        node.startLine,
        node.endLine,
        this.height,
        this.doc.lines.length,
      )
      : frameTop(
        target.destLine,
        target.destLine,
        this.height,
        this.doc.lines.length,
      );
    if (
      target.destCol < this.left || target.destCol >= this.left + this.width
    ) {
      this.left = clamp(target.destCol - 4, 0, this.maxLineLen);
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
    const idx = nextMatchIndex(this.matches, this.top - 1, -1, jumpForward);
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
    return pol.editStart(this.doc.lines[line]?.text ?? "") !== null;
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
    if (m.line < this.top || m.line >= this.top + this.contentRows()) {
      this.top = clamp(
        m.line - Math.floor(this.contentRows() / 2),
        0,
        maxTop(this.doc.lines.length, this.height),
      );
    }
    if (m.start < this.left || m.start >= this.left + this.width) {
      this.left = clamp(m.start - 4, 0, this.maxLineLen);
    }
    this.message = "";
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
    const maxScroll = Math.max(0, this.activeOverlayLines(overlay).length - 1);
    const hasTargets = overlay.mode === "info" && overlay.targets.length > 0;
    switch (key.name) {
      case "escape":
      case "q":
        this.overlay = null;
        this.overlayScroll = 0;
        break;
      case "enter":
        // Follow the selected reference: open its node's card, or — when the
        // definition lives in another file — open that file in place.
        if (hasTargets && overlay.cardSel >= 0) {
          const target = overlay.targets[overlay.cardSel];
          if (target.filePath) {
            this.openExternalFile(target);
          } else {
            const node = this.resolveTargetNode(target);
            if (node) this.openPeek(node);
            else this.message = "Nothing to open for this reference";
          }
        } else {
          this.overlay = null;
          this.overlayScroll = 0;
        }
        break;
      case "z": {
        // Reveal the target: an external file opens in place; an in-blob target
        // closes the card and centres the main view on it.
        const reveal = this.overlayRevealTarget(overlay);
        if (reveal?.filePath) this.openExternalFile(reveal);
        else if (reveal) this.jumpToTarget(reveal);
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
    // Cursor off: a bare arrow reveals the text cursor (if editable).
    if (!key.alt && isArrowName(key.name)) {
      this.revealCursor();
      return;
    }

    const rows = this.contentRows();
    const lastTop = maxTop(this.doc.lines.length, this.height);
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
            node.startLine,
            node.endLine,
            this.height,
            this.doc.lines.length,
          );
        }
        return;
      }
      case "#":
        this.showLineNumbers = !this.showLineNumbers;
        return;
      case "escape":
        this.selectedIndex = null;
        this.query = "";
        this.matches = [];
        this.message = "";
        return;
    }
  }

  // --- editing ---------------------------------------------------------------

  private scrollOrPan(name: string): void {
    const lastTop = maxTop(this.doc.lines.length, this.height);
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
    this.buffer.place(this.top, 0);
    this.seedHighlighter();
    this.ensureCursorVisible();
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
    return pol.editStart(this.buffer!.lines[this.buffer!.row]);
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
    const gutter = this.showLineNumbers
      ? Math.max(4, String(this.doc.lines.length).length + 1)
      : 0;
    const guide = this.selectedNode() ? 1 : 0;
    return Math.max(1, this.width - gutter - guide);
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
    try {
      this.message = this.source.save(this.buffer.text());
      this.buffer.commitSaved();
      return true;
    } catch (e) {
      this.message = `Save failed: ${e instanceof Error ? e.message : e}`;
      return false;
    }
  }

  private requestQuit(): void {
    if (this.buffer?.dirty()) {
      this.mode = "savePrompt";
      this.savePromptThen = "quit";
      this.editedFiles = this.computeEditedFiles();
      const n = this.editedFiles.length;
      const what = n === 1 ? this.editedFiles[0] : `${n} files`;
      const saveWord = n > 1 ? "save all" : "save";
      this.message = `Save changes to ${what}?  ` +
        `(y) ${saveWord}   (d) discard   (c) cancel`;
    } else {
      this.quit = true;
    }
  }

  /** The files a save would write — just those an edit actually touched, not
   * every file a diff spans. Falls back to the source's single label. */
  private computeEditedFiles(): string[] {
    if (!this.source || !this.buffer) return [];
    const labels = this.source.dirtyLabels?.(
      this.buffer.baseline(),
      this.buffer.text(),
    );
    if (labels && labels.length > 0) return labels;
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

  private handleSavePrompt(key: Key): void {
    const k = (key.char ?? key.name).toLowerCase();
    if (k === "y") {
      const ok = this.requestSave();
      this.mode = "normal";
      this.editedFiles = [];
      if (ok && this.savePromptThen === "quit") this.quit = true;
      this.savePromptThen = null;
    } else if (k === "d") {
      this.mode = "normal";
      this.editedFiles = [];
      if (this.savePromptThen === "quit") this.quit = true;
      this.savePromptThen = null;
    } else if (k === "c" || key.name === "escape") {
      this.mode = "normal";
      this.savePromptThen = null;
      this.editedFiles = [];
      this.message = "Cancelled";
    }
  }

  /** Open the revert prompt (Ctrl-R while editing): a diff offers hunk / file /
   * all; a plain file reverts wholesale. */
  private openRevertPrompt(): void {
    if (!this.buffer?.dirty()) {
      this.message = "Nothing to revert.";
      return;
    }
    this.mode = "revertPrompt";
    this.message = this.source?.policy
      ? "Revert  (c) hunk   (f) file   (a) all   ·   esc cancel"
      : "Revert all edits?   (y) yes   ·   esc cancel";
  }

  private handleRevertPrompt(key: Key): void {
    const k = (key.char ?? key.name).toLowerCase();
    let scope: RevertScope | null = null;
    if (this.source?.policy) {
      scope = k === "c"
        ? "chunk"
        : k === "f"
        ? "file"
        : k === "a"
        ? "all"
        : null;
    } else if (k === "y" || k === "a") {
      scope = "all";
    }
    if (scope) this.performRevert(scope);
    else this.message = "Cancelled";
    this.mode = "normal";
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
      b.row < b.lines.length - 1 && pol.editStart(b.lines[b.row]) === null
    ) {
      b.place(b.row + 1, 0);
    }
  }

  /** Reveal more of the underlying file around a hunk (Ctrl-L). When the text
   * cursor is active the hunk is the one it sits in; in pager mode it is the
   * selected node's hunk, or the first hunk on screen. The extra context is
   * applied to the baseline too, so it does not count as an unsaved edit. */
  private performExpand(): void {
    if (!this.source?.expandContext || !this.buffer) {
      this.message = "Expanding context isn't available here.";
      return;
    }
    const refLine = this.cursorOn ? this.buffer.row : this.expandRefLine();
    if (refLine === null) {
      this.message = "Move to a hunk first, then Ctrl-L to expand its context.";
      return;
    }
    const r = this.source.expandContext(
      this.buffer.text(),
      this.buffer.baseline(),
      refLine,
    );
    if (!r) {
      this.message = "No more context to show.";
      return;
    }
    // The node the selection denotes, captured before the reparse renumbers the
    // structure tree under it.
    const selected = this.cursorOn ? null : this.selectedNode();
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
      this.message = "Expanded context.";
      return;
    }
    // Pager mode: re-point the selection at the same node (its line shifted),
    // and hold the viewport on the same content. Only lines at or below the
    // insertion point moved down, so the top shifts only when it is below it.
    this.reselectAfterExpand(selected, r.insertedAt, r.inserted);
    if (this.top >= r.insertedAt) this.top += r.inserted;
    this.clampScroll();
    this.message = "Expanded context.";
  }

  /** After a pager-mode expand rebuilds the structure tree, point the selection
   * back at the same node, whose line shifted down by `inserted` when it sat at
   * or below the insertion point. Cleared when the node can no longer be found.
   * A hunk is matched on its line alone — only one hunk starts at a given header
   * line, and its label (the `@@` counts) changes as the hunk grows; other kinds
   * keep the label, which is stable and tells apart nodes sharing a start line. */
  private reselectAfterExpand(
    node: StructureNode | null,
    insertedAt: number,
    inserted: number,
  ): void {
    if (!node) return;
    const startLine = node.startLine >= insertedAt
      ? node.startLine + inserted
      : node.startLine;
    const idx = this.doc.flatStructure.findIndex((n) =>
      n.startLine === startLine && n.kind === node.kind &&
      (node.kind === "hunk" || n.label === node.label)
    );
    this.selectedIndex = idx >= 0 ? idx : null;
  }

  /** The reference line for an expand in pager mode: a line inside the hunk the
   * user is focused on — the selected node's hunk when a node is selected and on
   * screen, otherwise the first hunk overlapping the viewport. A node that spans
   * hunks rather than sitting in one (the file node) resolves to the first hunk
   * it covers that is on screen. Null when no hunk is in view. */
  private expandRefLine(): number | null {
    const rows = this.contentRows();
    const viewEnd = this.top + rows;
    const onScreen = (n: StructureNode) =>
      n.endLine >= this.top && n.startLine < viewEnd;
    const hunks = this.doc.flatStructure.filter((n) => n.kind === "hunk");
    if (hunks.length === 0) return null;
    const sel = this.selectedNode();
    if (sel && onScreen(sel)) {
      // A selection sitting inside a hunk keeps its line, so the up/down bias
      // follows where the user is.
      const inHunk = hunks.some((h) =>
        sel.startLine >= h.startLine && sel.startLine <= h.endLine
      );
      if (inHunk) return sel.startLine;
      // A selection spanning hunks (the file node) expands the first hunk it
      // covers that is on screen.
      const covered = hunks.find((h) =>
        h.startLine >= sel.startLine && onScreen(h)
      );
      if (covered) return covered.startLine;
    }
    const first = hunks.find(onScreen);
    return first ? first.startLine : null;
  }

  // --- file picker (C-x C-f) -------------------------------------------------

  private openFilePicker(): void {
    if (!this.files) {
      this.message = "Opening files isn't available here.";
      return;
    }
    this.cursorOn = false;
    this.overlay = null;
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
    this.currentDoc = opened.source.parse(opened.text);
    this.semantics = undefined; // the old service was for the previous file
    this.mode = "normal";
    this.cursorOn = false;
    this.overlay = null;
    this.overlayScroll = 0;
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
    if (this.selectedIndex === null) {
      this.selectNode(
        nodeForViewport(this.doc.flatStructure, this.top, this.height),
      );
      return;
    }
    this.selectNode(step(this.doc.flatStructure, this.selectedIndex));
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
    ["  k / j", "line up / down"],
    ["  h / l", "scroll left / right"],
    ["  ⌥↑ ⌥↓ ⌥← ⌥→", "scroll / pan (cursor keys, when editing)"],
    ["  Space / b", "page down / up"],
    ["  ^D / ^U", "half page down / up"],
    ["  g / G", "top / bottom"],
    ["", ""],
    ["Search", ""],
    ["  /", "search (smartcase, incremental)"],
    ["  n / N", "next / previous match"],
    ["", ""],
    ["Structure tree", ""],
    ["  w / s", "previous / next sibling (w → parent, s → out, at ends)"],
    ["  a / d", "parent / first child"],
    ["  Tab / ⇧Tab", "next / previous node (depth-first)"],
    ["  z", "centre selected node"],
    ["  ^L", "diff: reveal more of the file around the hunk in view"],
    ["  Esc", "clear selection / search"],
    ["", ""],
    ["Editing (a file or a diff)", ""],
    ["  ↑ ↓ ← →", "show & move the text cursor   ·   Esc hides it"],
    ["  ^A ^E  ⌥f ⌥b", "line start / end   ·   word forward / back"],
    ["  ^K ^Y  ^W ^Space", "kill line / yank   ·   kill region / set mark"],
    ["  ⌥l ⌥u ⌥c", "lower / upper / capitalise word"],
    ["  ^S", "search from the cursor (Enter lands there, ^S steps)"],
    ["  ^R", "revert: a diff's hunk / file / all, or a file's edits"],
    ["  ^L", "diff: reveal more of the file around the cursor's hunk"],
    ["  F3  ^X^S", "save to disk"],
    ["  ^X^F", "open another file"],
    ["", ""],
    ["Info card (Enter on a node)", ""],
    ["  Enter", "open the selected reference's card"],
    ["  z", "close & centre the main view on the target"],
    ["  Tab", "toggle info card ⇄ source"],
    ["  t", "look up a definition by name"],
    ["", ""],
    ["View", ""],
    ["  #", "toggle line numbers"],
    ["  ?", "this help   ·   q  quit"],
  ];
  const info: Line[] = rows.map(([k, v]) => {
    const text = v ? `${k.padEnd(22)} ${v}` : k;
    const spans = v
      ? [
        { col: 0, text: k.padEnd(22), cls: "builderCall" as TokenClass },
        { col: 22, text: ` ${v}`, cls: "comment" as TokenClass },
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
    staticFooter: "esc / q close",
  };
}
