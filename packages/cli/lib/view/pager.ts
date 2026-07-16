/**
 * Interactive less-like controller. The only module that touches the TTY: it
 * reads keystrokes from `/dev/tty` (stdin is the piped source text), renders
 * frames to `Deno.stdout`, and restores the terminal on every exit path.
 *
 * All state and key handling live in {@link Session} (testable, no I/O); this
 * driver wires it to the terminal and the {@link renderFrame} renderer. The raw
 * terminal and process operations are reached through an injectable {@link
 * PagerDeps} so the driver's control flow can be exercised without a real TTY;
 * {@link realPagerDeps} supplies the genuine Deno calls.
 */
import { CSI, term } from "./ansi.ts";
import type { Document } from "./model.ts";
import { decodeKeys } from "./keys.ts";
import { cursorScreenPos, renderFrame } from "./render.ts";
import { Session, type SessionOptions } from "./session.ts";
import { ui } from "./theme.ts";
import { createSemantics, type Semantics } from "./semantics.ts";
import type { EditableSource } from "./editsource.ts";
import { realFileGateway } from "./filegateway.ts";
import { ViewError } from "./errors.ts";

const encoder = new TextEncoder();

/** Idle gap after the last keystroke before the deferred structure re-parse
 * runs. Highlighting is not deferred — it re-runs on every keystroke. */
const REPARSE_DEBOUNCE_MS = 150;

export type PagerOptions = SessionOptions;

/** The keyboard handle the pager reads from — satisfied by a `Deno.FsFile`. */
export interface PagerTty {
  read(buffer: Uint8Array): Promise<number | null>;
  setRaw(mode: boolean): void;
  close(): void;
}

/** The terminal/process operations the pager performs, injected so the driver
 * is testable without a real terminal. */
export interface PagerDeps {
  /** Open the controlling terminal for reading; throws when there is none. */
  openTty(): PagerTty;
  write(text: string): void;
  /** The terminal size; may throw when there is no console. */
  consoleSize(): { columns: number; rows: number };
  env(key: string): string | undefined;
  addSignalListener(signal: Deno.Signal, handler: () => void): void;
  removeSignalListener(signal: Deno.Signal, handler: () => void): void;
  exit(code: number): never;
  /** Schedule `handler` after `ms`; returns a function that cancels it. */
  setTimer(handler: () => void, ms: number): () => void;
}

/** The real terminal and process operations. */
export function realPagerDeps(): PagerDeps {
  return {
    openTty: () => Deno.openSync("/dev/tty", { read: true }),
    write: (text) => {
      Deno.stdout.writeSync(encoder.encode(text));
    },
    consoleSize: Deno.consoleSize,
    env: (key) => Deno.env.get(key),
    addSignalListener: Deno.addSignalListener,
    removeSignalListener: Deno.removeSignalListener,
    exit: Deno.exit,
    setTimer: (handler, ms) => {
      const id = setTimeout(handler, ms);
      return () => clearTimeout(id);
    },
  };
}

export async function runPager(
  doc: Document,
  options: PagerOptions,
  semanticsIn?: Semantics,
  editSource?: EditableSource,
  deps: PagerDeps = realPagerDeps(),
): Promise<void> {
  let tty: PagerTty;
  try {
    tty = deps.openTty();
  } catch (error) {
    throw new ViewError(
      `cf view: cannot open /dev/tty for keyboard input (${
        error instanceof Error ? error.message : String(error)
      }). Pipe through a real terminal, or use --plain.`,
    );
  }

  // A best-effort semantic service for inferred types / cross-file definitions.
  // Construction is cheap (the TypeScript program is built lazily on first use)
  // and every query degrades to nothing, so this never blocks startup or fails
  // the pager when the text is not a resolvable module graph. The caller picks
  // the right service for the input (transformed blob vs diff); fall back to
  // the blob service.
  const semantics = semanticsIn ??
    createSemantics(doc.text, { cwd: Deno.cwd() }) ?? undefined;

  // The terminal fills the area outside the character grid (the sub-cell padding
  // below the last row) with its default background. Set that to the status
  // bar's colour so the strip beneath the last line blends in instead of showing
  // the terminal's own background; restore it on exit. Only with colour on.
  const padBg = options.color ? ui.statusBar.bg : undefined;

  const session = new Session(
    doc,
    options,
    consoleSize(deps),
    semantics,
    editSource,
    realFileGateway(),
  );

  const draw = () => {
    const view = session.view();
    const doc = session.displayDoc();
    const rows = renderFrame(doc, view);
    // Re-assert the padding background every frame. Some terminals drop the
    // OSC 11 default set at startup after the first repaint, so setting it once
    // is not enough; re-sending the same value is a no-op where it already holds.
    let out = (padBg ? term.setDefaultBg(padBg) : "") +
      `${CSI}?7l${term.hideCursor}`; // disable autowrap while drawing
    for (let i = 0; i < rows.length; i++) {
      out += term.moveTo(i + 1, 1) + term.clearLine + rows[i];
    }
    out += `${CSI}?7h`;
    // Show the text cursor at its cell when edit mode has one; otherwise the
    // terminal cursor stays hidden.
    const cur = cursorScreenPos(doc, view);
    if (cur) out += term.moveTo(cur.row, cur.col) + term.showCursor;
    deps.write(out);
  };

  // The session re-highlights on every keystroke but defers the full parse;
  // run it once typing pauses so the structure tree and cross-references catch
  // up without making each keystroke pay for the whole-AST build.
  let cancelReparse: (() => void) | undefined;
  const scheduleReparse = () => {
    if (cancelReparse) {
      cancelReparse();
    }
    cancelReparse = deps.setTimer(() => {
      cancelReparse = undefined;
      session.reparse();
      draw();
    }, REPARSE_DEBOUNCE_MS);
  };

  let cleanedUp = false;
  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    try {
      tty.setRaw(false);
    } catch { /* ignore */ }
    deps.write(
      `${CSI}?7h${term.showCursor}` +
        (padBg ? term.resetDefaultBg : "") + term.leaveAltScreen,
    );
    try {
      tty.close();
    } catch { /* ignore */ }
  };

  const onResize = () => {
    const s = consoleSize(deps);
    session.resize(s.width, s.height);
    draw();
  };
  const terminate = (code: number) => {
    cleanup();
    deps.exit(code);
  };
  // A SIGINT (Ctrl+C reaching us as a signal rather than the in-band 0x03 byte,
  // e.g. a forwarded interrupt) routes through the save prompt when there are
  // unsaved edits; the read loop then handles the y/n/c answer. A second
  // interrupt, or a clean buffer, terminates.
  const onInterrupt = () => {
    if (session.requestQuitFromSignal()) draw();
    else terminate(130);
  };
  const onTerminate = () => terminate(143);

  try {
    deps.addSignalListener("SIGWINCH", onResize);
  } catch { /* not on this platform */ }
  deps.addSignalListener("SIGINT", onInterrupt);
  deps.addSignalListener("SIGTERM", onTerminate);

  tty.setRaw(true);
  deps.write(
    `${term.enterAltScreen}${term.hideCursor}` +
      (padBg ? term.setDefaultBg(padBg) : ""),
  );

  const buf = new Uint8Array(4096);
  let leftover: Uint8Array = new Uint8Array(0);
  try {
    draw();
    // Warm the TypeScript program after the first frame is on screen, while the
    // user is reading it and before any keypress arrives, so the first info card
    // does not pay the one-time build cost on the interactive path.
    if (semantics) deps.setTimer(() => semantics.prewarm(), 0);
    while (!session.quit) {
      const n = await tty.read(buf);
      if (n === null) {
        break;
      }
      const chunk = concat(leftover, buf.subarray(0, n));
      const { keys, rest } = decodeKeys(chunk);
      leftover = rest;
      for (const key of keys) {
        session.handleKey(key);
        if (session.quit) break;
      }
      if (!session.quit) {
        draw();
        if (session.needsReparse) scheduleReparse();
      }
    }
  } finally {
    if (cancelReparse) {
      cancelReparse();
    }
    try {
      deps.removeSignalListener("SIGINT", onInterrupt);
      deps.removeSignalListener("SIGTERM", onTerminate);
      deps.removeSignalListener("SIGWINCH", onResize);
    } catch { /* ignore */ }
    cleanup();
  }
}

function consoleSize(deps: PagerDeps): { width: number; height: number } {
  try {
    const { columns, rows } = deps.consoleSize();
    if (columns > 0 && rows > 0) return { width: columns, height: rows };
  } catch { /* fall through to env / defaults */ }
  const envW = Number.parseInt(deps.env("COLUMNS") ?? "", 10);
  const envH = Number.parseInt(deps.env("LINES") ?? "", 10);
  return {
    width: Number.isFinite(envW) && envW > 0 ? envW : 80,
    height: Number.isFinite(envH) && envH > 0 ? envH : 24,
  };
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length === 0) return b.slice();
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}
