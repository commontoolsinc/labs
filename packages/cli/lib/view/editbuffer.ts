/**
 * A pure text-editing engine: an array of lines with a cursor, an Emacs-style
 * kill ring, and word/line operations. No terminal, no files, no parsing — it
 * mutates text and reports its state, so it unit-tests without any I/O. The
 * session wraps it (mapping the cursor to the view and re-parsing for live
 * highlighting); persistence and the diff/file plumbing live elsewhere.
 *
 * Columns are code points, matching the renderer's display columns: a line is
 * handled as its code-point array so the cursor never lands inside a surrogate
 * pair. Cursor moves step whole characters; edits splice whole characters.
 */

/** What a kill operation appends to: tracks consecutive kills for accretion. */
type LastKill = "none" | "append" | "prepend";

export class EditBuffer {
  lines: string[];
  /** 0-based cursor line. */
  row = 0;
  /** 0-based cursor column, in code points within the line. */
  col = 0;
  /** The "goal" column for vertical motion, so up/down keep the column over
   * short lines (Emacs/most editors). -1 means "track the current column". */
  private goalCol = -1;
  /** Mark for region operations (C-Space … C-w), or null. */
  mark: { row: number; col: number } | null = null;

  /** The kill ring, most-recent first. */
  killRing: string[] = [];
  /** Index of the entry the next yank-pop will use; -1 when not yank-popping. */
  private yankIndex = -1;
  /** [row, col] span the last yank inserted, for yank-pop to replace. */
  private lastYank:
    | { row: number; col: number; endRow: number; endCol: number }
    | null = null;
  private lastKill: LastKill = "none";

  private original: string;

  constructor(text: string) {
    this.original = text;
    this.lines = text.split("\n");
    if (this.lines.length === 0) this.lines = [""];
  }

  // --- state ----------------------------------------------------------------

  text(): string {
    return this.lines.join("\n");
  }

  dirty(): boolean {
    return this.text() !== this.original;
  }

  /** Make the current text the clean baseline (after a successful save). */
  commitSaved(): void {
    this.original = this.text();
  }

  /** Replace the clean baseline without touching the cursor or current text.
   * Used when revealing diff context, which is applied to both sides so it does
   * not read as an edit. */
  setBaseline(text: string): void {
    this.original = text;
  }

  /** The clean baseline — the text this buffer was created with (or last saved
   * to). Edits are measured against it. */
  baseline(): string {
    return this.original;
  }

  /** Replace the whole text and place the cursor, keeping the clean baseline —
   * so a revert that restores part of the text still measures dirtiness against
   * the true original. */
  setText(text: string, row = 0, col = 0): void {
    this.resetGoal();
    this.endKill();
    this.endYank();
    this.mark = null;
    this.lines = text.split("\n");
    if (this.lines.length === 0) this.lines = [""];
    this.row = clamp(row, 0, this.lines.length - 1);
    this.col = clamp(col, 0, this.lineLen(this.row));
  }

  /** Replace `count` lines starting at `row` with `replacement`, leaving the
   * cursor on line `row + cursorRow` at `cursorCol`. The diff editor uses this
   * to split a context line into a removed/added pair and to collapse an
   * unchanged pair back into a context line. */
  spliceLines(
    row: number,
    count: number,
    replacement: string[],
    cursorRow: number,
    cursorCol: number,
  ): void {
    this.resetGoal();
    this.endKill();
    this.endYank();
    this.lines.splice(row, count, ...replacement);
    if (this.lines.length === 0) this.lines = [""];
    this.row = clamp(row + cursorRow, 0, this.lines.length - 1);
    this.col = clamp(cursorCol, 0, this.lineLen(this.row));
  }

  private chars(row: number): string[] {
    return [...(this.lines[row] ?? "")];
  }

  private lineLen(row: number): number {
    return this.chars(row).length;
  }

  /** Code-point length of the cursor's current line. */
  currentLineLength(): number {
    return this.lineLen(this.row);
  }

  /** Place the cursor, clamped into range; resets motion/kill/yank state. */
  place(row: number, col: number): void {
    this.resetGoal();
    this.endKill();
    this.endYank();
    this.row = clamp(row, 0, this.lines.length - 1);
    this.col = clamp(col, 0, this.lineLen(this.row));
  }

  /** Call before a non-vertical action so it does not inherit a stale goal. */
  private resetGoal(): void {
    this.goalCol = -1;
  }

  private endKill(): void {
    this.lastKill = "none";
  }

  private endYank(): void {
    this.yankIndex = -1;
    this.lastYank = null;
  }

  // --- cursor motion --------------------------------------------------------

  moveLeft(): void {
    this.resetGoal();
    this.endKill();
    this.endYank();
    if (this.col > 0) this.col -= 1;
    else if (this.row > 0) {
      this.row -= 1;
      this.col = this.lineLen(this.row);
    }
  }

  moveRight(): void {
    this.resetGoal();
    this.endKill();
    this.endYank();
    if (this.col < this.lineLen(this.row)) this.col += 1;
    else if (this.row < this.lines.length - 1) {
      this.row += 1;
      this.col = 0;
    }
  }

  moveUp(): void {
    this.endKill();
    this.endYank();
    if (this.goalCol < 0) this.goalCol = this.col;
    if (this.row > 0) {
      this.row -= 1;
      this.col = Math.min(this.goalCol, this.lineLen(this.row));
    }
  }

  moveDown(): void {
    this.endKill();
    this.endYank();
    if (this.goalCol < 0) this.goalCol = this.col;
    if (this.row < this.lines.length - 1) {
      this.row += 1;
      this.col = Math.min(this.goalCol, this.lineLen(this.row));
    }
  }

  moveLineStart(): void { // C-a
    this.resetGoal();
    this.endKill();
    this.endYank();
    this.col = 0;
  }

  moveLineEnd(): void { // C-e
    this.resetGoal();
    this.endKill();
    this.endYank();
    this.col = this.lineLen(this.row);
  }

  moveBufferStart(): void {
    this.resetGoal();
    this.endKill();
    this.endYank();
    this.row = 0;
    this.col = 0;
  }

  moveBufferEnd(): void {
    this.resetGoal();
    this.endKill();
    this.endYank();
    this.row = this.lines.length - 1;
    this.col = this.lineLen(this.row);
  }

  moveWordForward(): void { // M-f
    this.resetGoal();
    this.endKill();
    this.endYank();
    const pos = this.nextWordEnd(this.row, this.col);
    this.row = pos.row;
    this.col = pos.col;
  }

  moveWordBackward(): void { // M-b
    this.resetGoal();
    this.endKill();
    this.endYank();
    const pos = this.prevWordStart(this.row, this.col);
    this.row = pos.row;
    this.col = pos.col;
  }

  setMark(): void { // C-Space
    this.mark = { row: this.row, col: this.col };
  }

  // --- insertion ------------------------------------------------------------

  insert(s: string): void {
    this.resetGoal();
    this.endKill();
    this.endYank();
    if (s.length === 0) return;
    if (s.includes("\n")) {
      for (const ch of s) {
        if (ch === "\n") this.splitLine();
        else this.insertChar(ch);
      }
      return;
    }
    for (const ch of [...s]) this.insertChar(ch);
  }

  insertChar(ch: string): void { // a single code point
    const cps = this.chars(this.row);
    cps.splice(this.col, 0, ch);
    this.lines[this.row] = cps.join("");
    this.col += 1;
  }

  insertNewline(): void {
    this.resetGoal();
    this.endKill();
    this.endYank();
    this.splitLine();
  }

  private splitLine(): void {
    const cps = this.chars(this.row);
    const before = cps.slice(0, this.col).join("");
    const after = cps.slice(this.col).join("");
    this.lines.splice(this.row, 1, before, after);
    this.row += 1;
    this.col = 0;
  }

  // --- deletion -------------------------------------------------------------

  deleteBackward(): void { // Backspace
    this.resetGoal();
    this.endKill();
    this.endYank();
    if (this.col > 0) {
      const cps = this.chars(this.row);
      cps.splice(this.col - 1, 1);
      this.lines[this.row] = cps.join("");
      this.col -= 1;
    } else if (this.row > 0) {
      const prevLen = this.lineLen(this.row - 1);
      this.lines[this.row - 1] += this.lines[this.row];
      this.lines.splice(this.row, 1);
      this.row -= 1;
      this.col = prevLen;
    }
  }

  deleteForward(): void { // Delete / C-d
    this.resetGoal();
    this.endKill();
    this.endYank();
    if (this.col < this.lineLen(this.row)) {
      const cps = this.chars(this.row);
      cps.splice(this.col, 1);
      this.lines[this.row] = cps.join("");
    } else if (this.row < this.lines.length - 1) {
      this.lines[this.row] += this.lines[this.row + 1];
      this.lines.splice(this.row + 1, 1);
    }
  }

  // --- kill / yank ----------------------------------------------------------

  /** C-k: kill to end of line; at end of line, kill the newline (join next). */
  killLine(): void {
    this.resetGoal();
    this.endYank();
    const cps = this.chars(this.row);
    if (this.col < cps.length) {
      const killed = cps.slice(this.col).join("");
      this.lines[this.row] = cps.slice(0, this.col).join("");
      this.pushKill(killed, "append");
    } else if (this.row < this.lines.length - 1) {
      this.lines[this.row] += this.lines[this.row + 1];
      this.lines.splice(this.row + 1, 1);
      this.pushKill("\n", "append");
    }
  }

  /** Kill the whole current line (its text and its newline). */
  killWholeLine(): void {
    this.resetGoal();
    this.endYank();
    // The killed line has a terminating newline only when it is not the last
    // line; killing the last line (no newline after it) must not add one, or a
    // later yank would insert a spurious trailing newline.
    const hadNewline = this.row < this.lines.length - 1;
    const text = this.lines[this.row] + (hadNewline ? "\n" : "");
    if (this.lines.length === 1) {
      this.lines[0] = "";
    } else {
      this.lines.splice(this.row, 1);
      if (this.row >= this.lines.length) this.row = this.lines.length - 1;
    }
    this.col = 0;
    this.pushKill(text, "append");
  }

  killWordForward(): void { // M-d
    this.resetGoal();
    this.endYank();
    const end = this.nextWordEnd(this.row, this.col);
    const killed = this.cut(this.row, this.col, end.row, end.col);
    this.pushKill(killed, "append");
  }

  killWordBackward(): void { // M-Backspace
    this.resetGoal();
    this.endYank();
    const start = this.prevWordStart(this.row, this.col);
    const killed = this.cut(start.row, start.col, this.row, this.col);
    this.row = start.row;
    this.col = start.col;
    this.pushKill(killed, "prepend");
  }

  /** C-w: kill the region between the mark and the cursor. */
  killRegion(): void {
    this.resetGoal();
    this.endYank();
    if (!this.mark) return;
    const [a, b] = orderPoints(this.mark, { row: this.row, col: this.col });
    const killed = this.cut(a.row, a.col, b.row, b.col);
    this.row = a.row;
    this.col = a.col;
    this.mark = null;
    this.pushKill(killed, "append");
  }

  yank(): void { // C-y
    this.resetGoal();
    this.endKill();
    if (this.killRing.length === 0) return;
    this.yankIndex = 0;
    this.insertYank(this.killRing[0]);
  }

  yankPop(): void { // M-y — only valid right after a yank/yank-pop
    this.resetGoal();
    this.endKill();
    if (this.yankIndex < 0 || !this.lastYank || this.killRing.length === 0) {
      return;
    }
    // Remove the previously-yanked text, then insert the next ring entry.
    const { row, col, endRow, endCol } = this.lastYank;
    this.cut(row, col, endRow, endCol);
    this.row = row;
    this.col = col;
    this.yankIndex = (this.yankIndex + 1) % this.killRing.length;
    this.insertYank(this.killRing[this.yankIndex]);
  }

  private insertYank(s: string): void {
    const startRow = this.row;
    const startCol = this.col;
    this.insertRaw(s);
    this.lastYank = {
      row: startRow,
      col: startCol,
      endRow: this.row,
      endCol: this.col,
    };
  }

  /** Insert without disturbing the yank/kill bookkeeping. */
  private insertRaw(s: string): void {
    for (const ch of s) {
      if (ch === "\n") this.splitLine();
      else this.insertChar(ch);
    }
  }

  private pushKill(text: string, mode: "append" | "prepend"): void {
    if (text.length === 0) return;
    if (this.lastKill !== "none" && this.killRing.length > 0) {
      // Accrete consecutive kills into one ring entry, like Emacs.
      this.killRing[0] = mode === "prepend"
        ? text + this.killRing[0]
        : this.killRing[0] + text;
    } else {
      this.killRing.unshift(text);
    }
    this.lastKill = mode;
    this.yankIndex = -1;
    this.lastYank = null;
  }

  // --- case operations (operate over the next word, advancing point) --------

  lowercaseWord(): void { // M-l
    this.transformWord((s) => s.toLowerCase());
  }

  uppercaseWord(): void { // M-u
    this.transformWord((s) => s.toUpperCase());
  }

  capitalizeWord(): void { // M-c
    this.transformWord((s) => {
      const m = s.match(/[\p{L}\p{N}]/u);
      if (!m || m.index === undefined) return s;
      const i = m.index;
      return s.slice(0, i) + s[i].toUpperCase() + s.slice(i + 1).toLowerCase();
    });
  }

  private transformWord(fn: (s: string) => string): void {
    this.resetGoal();
    this.endKill();
    this.endYank();
    const end = this.nextWordEnd(this.row, this.col);
    if (end.row !== this.row) {
      // Word ops stay on the current line for simplicity; move to its end.
      this.col = this.lineLen(this.row);
      return;
    }
    const cps = this.chars(this.row);
    const seg = cps.slice(this.col, end.col).join("");
    const replaced = [...fn(seg)];
    cps.splice(this.col, end.col - this.col, ...replaced);
    this.lines[this.row] = cps.join("");
    this.col = this.col + replaced.length;
  }

  // --- helpers --------------------------------------------------------------

  /** Cut text between two ordered points and return it; cursor left at a-side
   * is the caller's responsibility. */
  private cut(
    aRow: number,
    aCol: number,
    bRow: number,
    bCol: number,
  ): string {
    if (aRow === bRow) {
      const cps = this.chars(aRow);
      const out = cps.slice(aCol, bCol).join("");
      cps.splice(aCol, bCol - aCol);
      this.lines[aRow] = cps.join("");
      return out;
    }
    const first = this.chars(aRow);
    const last = this.chars(bRow);
    const parts: string[] = [first.slice(aCol).join("")];
    for (let r = aRow + 1; r < bRow; r++) parts.push(this.lines[r]);
    parts.push(last.slice(0, bCol).join(""));
    const head = first.slice(0, aCol).join("");
    const tail = last.slice(bCol).join("");
    this.lines.splice(aRow, bRow - aRow + 1, head + tail);
    return parts.join("\n");
  }

  private isWordChar(ch: string | undefined): boolean {
    return ch !== undefined && /[\p{L}\p{N}_]/u.test(ch);
  }

  /** End of the word at/after (row,col): skip non-word chars, then word chars. */
  private nextWordEnd(row: number, col: number): { row: number; col: number } {
    let r = row;
    let c = col;
    // Skip non-word characters (crossing line ends).
    for (;;) {
      const cps = this.chars(r);
      if (c >= cps.length) {
        if (r < this.lines.length - 1) {
          r += 1;
          c = 0;
          continue;
        }
        return { row: r, col: c };
      }
      if (this.isWordChar(cps[c])) break;
      c += 1;
    }
    const cps = this.chars(r);
    while (c < cps.length && this.isWordChar(cps[c])) c += 1;
    return { row: r, col: c };
  }

  /** Start of the word at/before (row,col). */
  private prevWordStart(
    row: number,
    col: number,
  ): { row: number; col: number } {
    let r = row;
    let c = col;
    for (;;) {
      if (c <= 0) {
        if (r > 0) {
          r -= 1;
          c = this.lineLen(r);
          continue;
        }
        return { row: r, col: c };
      }
      if (this.isWordChar(this.chars(r)[c - 1])) break;
      c -= 1;
    }
    while (c > 0 && this.isWordChar(this.chars(r)[c - 1])) c -= 1;
    return { row: r, col: c };
  }
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function orderPoints(
  a: { row: number; col: number },
  b: { row: number; col: number },
): [{ row: number; col: number }, { row: number; col: number }] {
  if (a.row < b.row || (a.row === b.row && a.col <= b.col)) return [a, b];
  return [b, a];
}
