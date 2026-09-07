/**
 * The one module that touches a terminal: raw mode, the bytes that arrive on
 * it, and the bytes shuttle sends back.
 *
 * Everything else in shuttle is a value and a decision about a value, which is
 * what lets the prompt loop, the verbs and the place all run with nothing
 * behind them. Keeping the terminal in one module is what that costs and what
 * it buys, and it is the architecture the view substrate this borrows from
 * already proves out.
 *
 * Raw mode is why the prompt exists at all: it is what stops the terminal
 * echoing and line-buffering, so that a keystroke reaches the line editor
 * instead of the editor the terminal driver would otherwise be.
 */

import { decodeKeys, type Key } from "../view/keys.ts";
import { ASSUMED_COLUMNS, ASSUMED_ROWS } from "./page.ts";
import {
  above,
  finish,
  NOTHING_PAINTED,
  type PaintedLine,
  repaint,
} from "./paint.ts";
import type { PromptTerminal } from "./prompt.ts";

/** How many bytes one read off the keyboard takes at a time. */
const READ_SIZE = 1024;

/**
 * The signals that end a run, and the status each one reports.
 *
 * A signal ends the process without unwinding, so the `finally` that takes the
 * terminal back out of raw mode never runs and the person is left at a
 * terminal that neither echoes nor edits. Handling these is what puts it back.
 *
 * Each status is the 128 the shell convention adds to a signal's own number,
 * so a caller reading `$?` learns which one arrived. `SIGKILL` and `SIGSTOP`
 * are absent because no process may bind them — the runtime refuses with
 * `Binding to signal 'SIGKILL' is not allowed` — and a terminal left raw by
 * one of those is what `reset` is for.
 */
const ENDING_SIGNALS = [
  ["SIGHUP", 129],
  ["SIGINT", 130],
  ["SIGQUIT", 131],
  ["SIGTERM", 143],
] as const satisfies readonly (readonly [Deno.Signal, number])[];

/**
 * Runs `body` over the terminal on standard input and output, and returns what
 * it returned.
 *
 * Raw mode is entered before `body` and left after it, whatever `body` does,
 * because a terminal left in raw mode is one the person's next command cannot
 * be typed at. A signal never reaches that `finally`, so the ways of ending a
 * run that a process may bind are listened for and restore it themselves
 * ({@link ENDING_SIGNALS}); the listening starts before raw mode does, so
 * there is no moment where the mode is on and nothing would take it off.
 *
 * @throws Error if standard input or standard output is not a terminal. Both
 * halves are needed and for different reasons: the keys are what a terminal in
 * raw mode delivers, and what goes back is escape sequences that redraw a line
 * where it stands — which a file or a pipe records rather than obeys, leaving
 * a saved cursor and a clear-to-end-of-screen written into it as text. A shell
 * that half works is worse than one that says what it needs, and reading or
 * writing somewhere other than a terminal has an answer of its own that this
 * is not: deterministic behavior off a terminal arrives with the scripting
 * bundle (`docs/plans/shuttle/futures.md`), and nothing here stands in for it.
 */
export async function withPromptTerminal<T>(
  body: (terminal: PromptTerminal) => Promise<T>,
): Promise<T> {
  const redirected = !Deno.stdin.isTerminal()
    ? "input"
    : !Deno.stdout.isTerminal()
    ? "output"
    : undefined;
  if (redirected !== undefined) {
    throw new Error(
      `Shuttle reads its lines off a terminal and draws them back onto one, ` +
        `and standard ${redirected} is not one. Run it from a terminal.`,
    );
  }
  const cook = cooker();
  const listening = listenFor(cook);
  try {
    // Inside the `try` because the listeners are already on: raw mode failing
    // is a way this call can end, and every way it ends takes them off again.
    Deno.stdin.setRaw(true);
    return await body(new StandardTerminal());
  } finally {
    cook();
    for (const [signal, handler] of listening) {
      try {
        Deno.removeSignalListener(signal, handler);
      } catch {
        // Nothing else can be done about a listener that will not come off,
        // and the run is already over.
      }
    }
  }
}

/**
 * Helper for {@link withPromptTerminal}, which is a function taking standard
 * input back out of raw mode, and doing so once however many times it is
 * called.
 *
 * Two things call it and either may be first: a signal handler, and the run's
 * own way out. Once is what the terminal needs, and calling it again after the
 * process has begun to end is the case the memory is for.
 *
 * It swallows what the call throws, because every caller is already on its way
 * out and a terminal that will not leave raw mode is not a thing a message
 * about it could fix.
 */
function cooker(): () => void {
  let cooked = false;
  return () => {
    if (cooked) return;
    cooked = true;
    try {
      Deno.stdin.setRaw(false);
    } catch {
      // The terminal is gone, which is the other way of not being raw.
    }
  };
}

/**
 * Helper for {@link withPromptTerminal}, which asks to hear about each of
 * {@link ENDING_SIGNALS} and returns the ones that are now listened for.
 *
 * A handler restores the terminal before it ends the process, and in that
 * order on purpose: the restore is the part that must happen, so nothing that
 * could throw is allowed to precede it. What is left after it — ending the
 * process — is allowed to throw, because by then the terminal is already back
 * to the mode the person's next command is typed at.
 *
 * A signal the platform will not deliver is skipped rather than fatal: what it
 * costs is one way of ending that this run cannot restore from, and refusing
 * to start over it would cost every way.
 */
function listenFor(
  cook: () => void,
): readonly (readonly [Deno.Signal, () => void])[] {
  const listening: (readonly [Deno.Signal, () => void])[] = [];
  for (const [signal, status] of ENDING_SIGNALS) {
    const handler = () => {
      cook();
      Deno.exit(status);
    };
    try {
      Deno.addSignalListener(signal, handler);
      listening.push([signal, handler]);
    } catch {
      // Not a signal this platform delivers.
    }
  }
  return listening;
}

/**
 * The prompt's terminal, over standard input and standard output.
 *
 * It writes synchronously, which is what keeps a line and what it produced in
 * the order they happened rather than in the order two writes settled.
 */
class StandardTerminal implements PromptTerminal {
  #painted: PaintedLine = NOTHING_PAINTED;
  #encoder = new TextEncoder();
  #keys = typedKeys();

  /**
   * The keys typed on standard input — one stream for the life of the
   * instance, because two readers of one keyboard would each take some of
   * the keys and neither would see them all.
   */
  get keys(): AsyncIterable<Key> {
    return this.#keys;
  }

  /** @inheritDoc */
  edit(text: string, column: number): void {
    const line = { text, column, columns: this.#columns() };
    this.#send(repaint(this.#painted, line));
    this.#painted = line;
  }

  /** @inheritDoc */
  finish(): void {
    this.#send(finish(this.#painted));
    this.#painted = NOTHING_PAINTED;
  }

  /**
   * @inheritDoc
   *
   * The line stays as it was drawn, because what is written above it is
   * written above it: the drawing is composed against the same width and the
   * same cursor it already carries, so a run of these leaves one transcript
   * with the line being typed at the bottom of it.
   */
  announce(text: string): void {
    this.#send(above(this.#painted, text));
  }

  /**
   * Helper for the writes, which is how wide the terminal is.
   *
   * It is asked per drawing rather than once, so a window resized between two
   * keystrokes is drawn at the width it has now.
   */
  #columns(): number {
    return consoleColumns();
  }

  /**
   * Helper for the writes, which sends the whole of `text` to the terminal.
   *
   * A write is allowed to accept part of what it is offered, so what is left
   * is offered again until none is: a drawing that went out in pieces would
   * be escape sequences cut in half, and half a sequence is text on the
   * screen. This is `lib/view/mod.ts`'s `writeAllSync` in the module that
   * needs it, as `lib/view/filegateway.ts` also keeps one.
   *
   * @throws Error if a write accepts nothing at all, which no number of
   * further attempts would improve on.
   */
  #send(text: string): void {
    const bytes = this.#encoder.encode(text);
    let offset = 0;
    while (offset < bytes.length) {
      const written = Deno.stdout.writeSync(bytes.subarray(offset));
      if (written <= 0) {
        throw new Error("The terminal accepted none of what shuttle wrote.");
      }
      offset += written;
    }
  }
}

/**
 * How wide the terminal is: what it says, then `COLUMNS`, then an assumption.
 *
 * It is what a drawing is composed against, since a line wider than the
 * terminal occupies more rows than one and the redrawing has to know how many.
 */
export function consoleColumns(): number {
  return measured(
    (size) => size.columns,
    "COLUMNS",
    ASSUMED_COLUMNS,
  );
}

/**
 * How tall the terminal is: what it says, then `LINES`, then an assumption.
 *
 * It is what a page is bounded by (`page.ts`), so that a listing of a
 * populated space leaves the prompt and the rows above it on the screen. The
 * environment variable is `LINES`, which is the name the shell exports the
 * height under beside the `COLUMNS` the width goes by.
 */
export function consoleRows(): number {
  return measured((size) => size.rows, "LINES", ASSUMED_ROWS);
}

/**
 * Helper for the two above, which is the dimension `pick` reads: what the
 * terminal says, then what `variable` declares, then `assumed`.
 *
 * The three sources are the ones the pager (`lib/view/pager.ts`) asks in that
 * order, and a dimension is taken only where it is a finite count above zero,
 * so a terminal reporting none — which one that cannot measure itself does —
 * leads to the next source rather than into arithmetic over it. Each
 * dimension is decided on its own here, where the pager decides both on the
 * pair: a terminal answering with one usable dimension and one zero gives the
 * width from itself and the height from the environment, rather than both
 * from the environment.
 */
function measured(
  pick: (size: { columns: number; rows: number }) => number,
  variable: string,
  assumed: number,
): number {
  try {
    const measurement = pick(Deno.consoleSize());
    if (Number.isFinite(measurement) && measurement > 0) return measurement;
  } catch {
    // A terminal that will not answer is one of the ways of not knowing,
    // and the sources below are the rest.
  }
  const declared = Number.parseInt(Deno.env.get(variable) ?? "", 10);
  return Number.isFinite(declared) && declared > 0 ? declared : assumed;
}

/**
 * Helper for {@link StandardTerminal}, which is the keys typed on standard
 * input, ending when it does.
 *
 * The decoder is incremental: an escape sequence split across two reads leaves
 * its first bytes unconsumed, and they open the next read's bytes rather than
 * being decoded as the keys they are not.
 */
async function* typedKeys(): AsyncGenerator<Key> {
  const buffer = new Uint8Array(READ_SIZE);
  let rest: Uint8Array = new Uint8Array(0);
  while (true) {
    const read = await Deno.stdin.read(buffer);
    if (read === null) return;
    const arrived = new Uint8Array(rest.length + read);
    arrived.set(rest);
    arrived.set(buffer.subarray(0, read), rest.length);
    const decoded = decodeKeys(arrived);
    rest = decoded.rest;
    yield* decoded.keys;
  }
}
