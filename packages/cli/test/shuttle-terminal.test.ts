/**
 * Unit tests for the module that touches a terminal.
 *
 * There is no terminal behind them, and no process either: each case stands in
 * for the members of `Deno` the module reaches — the two streams, the signal
 * listeners, and the exit — and reads back what it did to them. That is what a
 * case can check about raw mode, which has no observable effect except on a
 * terminal, and about a signal, which no test process may deliver to itself
 * without ending: the calls are the whole of what this module owes, and
 * leaving one out is what the cases are for.
 *
 * What that leaves outside them, so nobody reads more into a green file than
 * it holds: no case delivers a real signal, and none puts a real terminal into
 * raw mode. A handler that the runtime never runs, and a `setRaw` that the
 * driver never honours, would both pass here.
 *
 * Standing in for a process-wide member means restoring it, and every case
 * restores in a `finally`, so a case that fails leaves the next one a `Deno`
 * that has not been edited.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { finish, NOTHING_PAINTED, repaint } from "../lib/shuttle/paint.ts";
import type { PromptTerminal } from "../lib/shuttle/prompt.ts";
import { withPromptTerminal } from "../lib/shuttle/terminal.ts";
import type { Key } from "../lib/view/keys.ts";

/** The members a case stands in for. */
interface Stubs {
  /** Whether standard input reports itself a terminal. */
  readonly inputIsTerminal?: () => boolean;

  /** Whether standard output reports itself a terminal. */
  readonly outputIsTerminal?: () => boolean;

  /** What the bytes of one read are, and `null` where the input ended. */
  readonly reads?: readonly (string | null)[];

  /** How wide the terminal says it is, or a throw where it will not say. */
  readonly consoleSize?: () => { columns: number; rows: number };

  /** What `COLUMNS` holds, and nothing where it holds nothing. */
  readonly columnsEnv?: string;

  /** How many of the bytes it is offered the terminal takes at a time. */
  readonly accepts?: (offered: number) => number;

  /** The signals this platform refuses to deliver, if any. */
  readonly unbindable?: readonly Deno.Signal[];

  /** A signal to deliver once the module is listening for it. */
  readonly raise?: Deno.Signal;
}

/** What a case saw the module do. */
interface Watched {
  /** Every raw-mode call, in order, by the mode it asked for. */
  readonly raw: boolean[];

  /** Everything written, joined as the terminal would have received it. */
  written(): string;

  /**
   * What the run threw, and nothing where it returned.
   *
   * It is reported rather than raised so that a case about a run that refused
   * can read the rest of this record. A case that raised it instead would be
   * asserting on stand-ins the helper had already put back.
   */
  readonly thrown: unknown;

  /** Every signal listened for, in the order the module asked. */
  readonly listened: Deno.Signal[];

  /** Every signal stopped being listened for, in the order it asked. */
  readonly released: Deno.Signal[];

  /** The status of every exit it asked for, in order. */
  readonly exits: (number | undefined)[];

  /**
   * The raw-mode calls and the exits together, in the one order they
   * happened, which is the only place their relative order is readable.
   */
  readonly order: string[];
}

/**
 * Helper for the cases below, which runs `body` over a stood-in `Deno` and
 * returns what the module did to it.
 *
 * A read with nothing left to deliver ends the input, so a case that never
 * reads is served by the same helper as one that reads to the end.
 */
async function watching(
  stubs: Stubs,
  body: (terminal: PromptTerminal) => Promise<void>,
): Promise<Watched> {
  const raw: boolean[] = [];
  const order: string[] = [];
  const chunks: string[] = [];
  let deliver: (() => void) | undefined;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const reads = [...(stubs.reads ?? [])];
  const original = {
    inputIsTerminal: Deno.stdin.isTerminal,
    outputIsTerminal: Deno.stdout.isTerminal,
    setRaw: Deno.stdin.setRaw,
    read: Deno.stdin.read,
    consoleSize: Deno.consoleSize,
    writeSync: Deno.stdout.writeSync,
    addSignalListener: Deno.addSignalListener,
    removeSignalListener: Deno.removeSignalListener,
    exit: Deno.exit,
  };
  // Both are stood in for whether or not a case says so: a test process is
  // ordinarily attached to neither, so the default is what every case but the
  // two about redirection needs.
  Deno.stdin.isTerminal = stubs.inputIsTerminal ?? (() => true);
  Deno.stdout.isTerminal = stubs.outputIsTerminal ?? (() => true);
  Deno.stdin.setRaw = (mode: boolean) => {
    raw.push(mode);
    order.push(mode ? "raw" : "cooked");
    // A signal arrives while the run is under way, which for a case is the
    // moment raw mode goes on: it is the first point at which the module has
    // something to restore.
    if (mode) deliver?.();
  };
  Deno.stdin.read = (buffer: Uint8Array) => {
    const next = reads.shift();
    if (next === undefined || next === null) return Promise.resolve(null);
    const bytes = encoder.encode(next);
    buffer.set(bytes);
    return Promise.resolve(bytes.length);
  };
  if (stubs.consoleSize !== undefined) Deno.consoleSize = stubs.consoleSize;
  Deno.stdout.writeSync = (bytes: Uint8Array) => {
    const taken = stubs.accepts?.(bytes.length) ?? bytes.length;
    chunks.push(decoder.decode(bytes.subarray(0, Math.max(taken, 0))));
    return taken;
  };
  const listened: Deno.Signal[] = [];
  const released: Deno.Signal[] = [];
  const exits: (number | undefined)[] = [];
  const handlers = new Map<Deno.Signal, () => void>();
  const unbindable = new Set(stubs.unbindable ?? []);
  Deno.addSignalListener = (signal: Deno.Signal, handler: () => void) => {
    if (unbindable.has(signal)) {
      throw new TypeError(`Binding to signal '${signal}' is not allowed`);
    }
    listened.push(signal);
    handlers.set(signal, handler);
  };
  Deno.removeSignalListener = (signal: Deno.Signal) => {
    released.push(signal);
  };
  // The stand-in returns where the real one does not, which is what lets a
  // case read what the handler did after asking to end. Nothing in the module
  // runs after the ask, so returning changes no order a case can see.
  Deno.exit = ((status?: number) => {
    exits.push(status);
    order.push(`exit ${status}`);
  }) as unknown as typeof Deno.exit;
  const priorColumns = Deno.env.get("COLUMNS");
  if (stubs.columnsEnv === undefined) Deno.env.delete("COLUMNS");
  else Deno.env.set("COLUMNS", stubs.columnsEnv);
  let thrown: unknown;
  if (stubs.raise !== undefined) {
    const signal = stubs.raise;
    deliver = () => handlers.get(signal)?.();
  }
  try {
    await withPromptTerminal(body);
  } catch (error) {
    thrown = error;
  } finally {
    if (priorColumns === undefined) Deno.env.delete("COLUMNS");
    else Deno.env.set("COLUMNS", priorColumns);
    Deno.stdin.isTerminal = original.inputIsTerminal;
    Deno.stdout.isTerminal = original.outputIsTerminal;
    Deno.stdin.setRaw = original.setRaw;
    Deno.stdin.read = original.read;
    Deno.consoleSize = original.consoleSize;
    Deno.stdout.writeSync = original.writeSync;
    Deno.addSignalListener = original.addSignalListener;
    Deno.removeSignalListener = original.removeSignalListener;
    Deno.exit = original.exit;
  }
  return {
    raw,
    written: () => chunks.join(""),
    thrown,
    listened,
    released,
    exits,
    order,
  };
}

/** Helper for the cases below, which is the message `thrown` carries. */
function message(thrown: unknown): string {
  return thrown instanceof Error ? thrown.message : `not thrown: ${thrown}`;
}

/** Helper for the cases below, which is a terminal `columns` wide. */
function wide(columns: number): () => { columns: number; rows: number } {
  return () => ({ columns, rows: 24 });
}

describe("terminal", () => {
  describe("withPromptTerminal()", () => {
    it("throws where standard input is not a terminal", async () => {
      const watched = await watching(
        { inputIsTerminal: () => false },
        () => Promise.resolve(),
      );
      expect(message(watched.thrown)).toContain("standard input is not one");
    });

    it("throws where standard output is not a terminal", async () => {
      // Redirecting the output alone leaves the keys arriving and the drawing
      // going into a file, which would record a saved cursor and a
      // clear-to-end-of-screen as text.

      const watched = await watching(
        { outputIsTerminal: () => false },
        () => Promise.resolve(),
      );
      expect(message(watched.thrown)).toContain("standard output is not one");
    });

    it("puts standard input in no mode at all where a stream is redirected", async () => {
      // The raw-mode calls read here are the helper's own record. A case that
      // stood in for `setRaw` itself would be replaced by the helper before
      // the run began, and would then see nothing whatever the run did.

      const watched = await watching(
        { outputIsTerminal: () => false },
        () => Promise.resolve(),
      );
      expect(watched.raw).toEqual([]);
    });

    it("puts standard input into raw mode and takes it back out", async () => {
      const watched = await watching({}, () => Promise.resolve());
      expect(watched.raw).toEqual([true, false]);
    });

    it("takes standard input back out of raw mode after a body that threw", async () => {
      // A terminal left in raw mode is one the person's next command cannot
      // be typed at, so what the body did decides nothing about this.

      const watched = await watching(
        {},
        () => Promise.reject(new Error("The body.")),
      );
      expect(message(watched.thrown)).toBe("The body.");
      expect(watched.raw).toEqual([true, false]);
    });

    it("listens for every signal a run can be ended by", async () => {
      // The four a process may bind. `SIGKILL` and `SIGSTOP` are not among
      // them because no process may bind either, which is a fact about the
      // platform rather than a choice this module made.

      const watched = await watching({}, () => Promise.resolve());
      expect(watched.listened).toEqual([
        "SIGHUP",
        "SIGINT",
        "SIGQUIT",
        "SIGTERM",
      ]);
    });

    it("stops listening for every one of them when the run is over", async () => {
      // A listener outliving the run would answer for a terminal this call no
      // longer holds, and take a later one out of a mode it had put it in.

      const watched = await watching({}, () => Promise.resolve());
      expect(watched.released).toEqual(watched.listened);
    });

    it("keeps listening for the rest where the platform refuses one", async () => {
      // One way of ending that cannot be restored from is what it costs;
      // refusing to start would cost every way.

      const watched = await watching(
        { unbindable: ["SIGQUIT"] },
        () => Promise.resolve(),
      );
      expect(watched.listened).toEqual(["SIGHUP", "SIGINT", "SIGTERM"]);
      expect(watched.thrown).toBe(undefined);
    });

    it("takes standard input back out of raw mode on a signal", async () => {
      // The failure this is for: a signal ends the process without unwinding,
      // so the `finally` never runs and the person is left at a terminal that
      // neither echoes nor edits until they type `reset` into the dark.

      const watched = await watching(
        { raise: "SIGTERM" },
        () => Promise.resolve(),
      );
      expect(watched.raw).toEqual([true, false]);
    });

    it("restores the terminal before it asks to end, not after", async () => {
      // The order is the whole guarantee, and it is why the restore is not
      // left to whatever the exit does: what follows the restore is allowed to
      // fail, and what precedes it is not.

      const watched = await watching(
        { raise: "SIGHUP" },
        () => Promise.resolve(),
      );
      expect(watched.order).toEqual(["raw", "cooked", "exit 129"]);
    });

    it("ends with the status the shell convention gives the signal", async () => {
      for (
        const [signal, status] of [
          ["SIGHUP", 129],
          ["SIGINT", 130],
          ["SIGQUIT", 131],
          ["SIGTERM", 143],
        ] as const
      ) {
        const watched = await watching({ raise: signal }, () => {
          return Promise.resolve();
        });
        expect(watched.exits).toEqual([status]);
      }
    });

    it("takes the terminal out of raw mode once, however it ended", async () => {
      // The signal handler and the run's own way out both restore, and either
      // may be first. A second call reaching the terminal would take a mode
      // off that something after this run had put on.

      const watched = await watching(
        { raise: "SIGINT" },
        () => Promise.resolve(),
      );
      expect(watched.raw.filter((mode) => !mode)).toEqual([false]);
    });

    it("writes nothing at all where the body wrote nothing", async () => {
      const watched = await watching({}, () => Promise.resolve());
      expect(watched.written()).toBe("");
    });

    it("writes what the painter composes for a line", async () => {
      const watched = await watching({ consoleSize: wide(40) }, (terminal) => {
        terminal.edit("ab", 2);
        return Promise.resolve();
      });
      expect(watched.written())
        .toBe(
          repaint(NOTHING_PAINTED, { text: "ab", column: 2, columns: 40 }),
        );
    });

    it("ends a line with what the painter composes for the ending", async () => {
      // Half of what a terminal is asked for is ending a line, and no case
      // above asks for it: every one of them draws and returns.

      const watched = await watching({ consoleSize: wide(40) }, (terminal) => {
        terminal.edit("ab", 2);
        terminal.finish("gone");
        return Promise.resolve();
      });
      expect(watched.written()).toBe(
        repaint(NOTHING_PAINTED, { text: "ab", column: 2, columns: 40 }) +
          finish({ text: "ab", column: 2, columns: 40 }, "gone"),
      );
    });

    it("draws the line after a finished one from the top of the screen", async () => {
      // What a finished line leaves behind is nothing to draw over. Were it
      // still thought to be on screen, the next drawing would open by climbing
      // over the rows it had wrapped to, and land a row above where it writes.

      const watched = await watching({ consoleSize: wide(40) }, (terminal) => {
        terminal.edit("a".repeat(45), 45);
        terminal.finish("");
        terminal.edit("b", 1);
        return Promise.resolve();
      });
      // The whole log rather than its tail: were the finished line still
      // thought to be drawn, the last drawing would open with a move up, and
      // a tail that ends with the right bytes would end with those too.
      const wrapped = { text: "a".repeat(45), column: 45, columns: 40 };
      expect(watched.written()).toBe(
        repaint(NOTHING_PAINTED, wrapped) +
          finish(wrapped, "") +
          repaint(NOTHING_PAINTED, { text: "b", column: 1, columns: 40 }),
      );
    });

    it("draws the second line over the first, from where the first left the cursor", async () => {
      const watched = await watching({ consoleSize: wide(40) }, (terminal) => {
        terminal.edit("a".repeat(45), 45);
        terminal.edit("b", 1);
        return Promise.resolve();
      });
      expect(watched.written()).toContain(
        repaint({ text: "a".repeat(45), column: 45, columns: 40 }, {
          text: "b",
          column: 1,
          columns: 40,
        }),
      );
    });

    it("draws at the width the terminal reports", async () => {
      const watched = await watching({ consoleSize: wide(40) }, (terminal) => {
        terminal.edit("a".repeat(45), 45);
        return Promise.resolve();
      });
      expect(watched.written()).toContain("\x1b[1B");
    });

    it("draws at the width the environment declares where the terminal will not", async () => {
      const watched = await watching({
        consoleSize: () => {
          throw new Deno.errors.NotFound("No console.");
        },
        columnsEnv: "20",
      }, (terminal) => {
        terminal.edit("a".repeat(25), 25);
        return Promise.resolve();
      });
      expect(watched.written()).toContain("\x1b8\x1b[1B\x1b[5C");
    });

    it("draws at the assumed width where the terminal reports no columns", async () => {
      // A terminal that cannot measure itself reports zero, which is not a
      // width to divide rows by: dividing at it puts `Infinity` into a cursor
      // parameter, which no terminal reads as a number of rows.

      const watched = await watching({
        consoleSize: () => ({ columns: 0, rows: 0 }),
      }, (terminal) => {
        terminal.edit("a".repeat(85), 85);
        return Promise.resolve();
      });
      expect(watched.written()).toContain("\x1b8\x1b[1B\x1b[5C");
    });

    it("draws at the assumed width where the environment declares no number", async () => {
      const watched = await watching({
        consoleSize: () => {
          throw new Deno.errors.NotFound("No console.");
        },
        columnsEnv: "wide",
      }, (terminal) => {
        terminal.edit("a".repeat(85), 85);
        return Promise.resolve();
      });
      expect(watched.written()).toContain("\x1b8\x1b[1B\x1b[5C");
    });

    it("writes every byte, where the terminal takes them a few at a time", async () => {
      // A write is allowed to accept part of what it is offered. Dropping the
      // rest would cut an escape sequence in half, and half a sequence is text
      // on the screen rather than a cursor move.

      const watched = await watching({
        consoleSize: wide(40),
        accepts: (offered) => Math.min(offered, 3),
      }, (terminal) => {
        terminal.edit("abcdefghij", 10);
        return Promise.resolve();
      });
      expect(watched.written())
        .toBe(repaint(NOTHING_PAINTED, {
          text: "abcdefghij",
          column: 10,
          columns: 40,
        }));
    });

    it("throws where the terminal accepts no bytes at all", async () => {
      const watched = await watching({
        consoleSize: wide(40),
        accepts: () => 0,
      }, (terminal) => {
        terminal.edit("ab", 2);
        return Promise.resolve();
      });
      expect(message(watched.thrown))
        .toBe("The terminal accepted none of what shuttle wrote.");
    });

    it("draws at an assumed width where the terminal will not report one", async () => {
      // A line 85 columns long wraps at the assumed 80 and not at anything
      // wider, so what the cursor move says is which width was used.

      const watched = await watching({
        consoleSize: () => {
          throw new Deno.errors.NotFound("No console.");
        },
      }, (terminal) => {
        terminal.edit("a".repeat(85), 85);
        return Promise.resolve();
      });
      expect(watched.written()).toContain("\x1b8\x1b[1B\x1b[5C");
    });

    it("reads the keys the bytes on standard input decode to", async () => {
      const keys: Key[] = [];
      await watching({ reads: ["ab"] }, async (terminal) => {
        for await (const key of terminal.keys) keys.push(key);
      });
      expect(keys).toEqual([
        { name: "a", char: "a" },
        { name: "b", char: "b" },
      ]);
    });

    it("carries an escape sequence split across two reads into the second", async () => {
      // The decoder returns the bytes it could not finish with, and they open
      // the next read rather than being decoded as the keys they are not.

      const keys: Key[] = [];
      await watching({ reads: ["\x1b[", "A"] }, async (terminal) => {
        for await (const key of terminal.keys) keys.push(key);
      });
      expect(keys).toEqual([{ name: "up" }]);
    });
  });
});
