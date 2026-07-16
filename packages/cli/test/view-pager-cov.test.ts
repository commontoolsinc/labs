/**
 * Drives runPager's control flow with an injected fake PagerDeps so every
 * terminal/process branch — the no-tty error, the read loop and its EOF break,
 * leftover-byte stitching, the deferred reparse timer, the resize/interrupt/
 * terminate signal handlers, the size fallback and the cleanup error paths —
 * runs without a real terminal. A separate test exercises the real deps' thin
 * wrappers.
 */
import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { parseDocument } from "./view-helpers.ts";
import {
  type PagerDeps,
  type PagerTty,
  realPagerDeps,
  runPager,
} from "../lib/view/pager.ts";
import { fileSource } from "../lib/view/editsource.ts";
import { ViewError } from "../lib/view/errors.ts";
import { term } from "../lib/view/ansi.ts";
import { ui } from "../lib/view/theme.ts";

const OPTS = { color: false, showLineNumbers: false };
const DOC = parseDocument("export const x = 1;\nconst y = x;\n");
const enc = (s: string) => new TextEncoder().encode(s);

class ExitSignal extends Error {
  constructor(public code: number) {
    super(`exit ${code}`);
  }
}

type Step =
  | { bytes: Uint8Array }
  | { eof: true }
  | { fire: Deno.Signal }
  | { fireTimers: true };

interface FakeOpts {
  steps?: Step[];
  openThrows?: boolean;
  setRawThrows?: boolean;
  closeThrows?: boolean;
  consoleSizeThrows?: boolean;
  consoleSize?: { columns: number; rows: number };
  addSignalThrowsFor?: Deno.Signal;
  removeSignalThrows?: boolean;
  env?: Record<string, string>;
}

function makeFake(opts: FakeOpts = {}) {
  const writes: string[] = [];
  const signals = new Map<string, () => void>();
  const removed: string[] = [];
  const timers = new Map<number, () => void>();
  const exited: number[] = [];
  let nextTimer = 1;
  const steps = (opts.steps ?? []).slice();

  const tty: PagerTty = {
    read(buf) {
      for (;;) {
        const step = steps.shift();
        if (!step) return Promise.resolve(null);
        if ("bytes" in step) {
          buf.set(step.bytes);
          return Promise.resolve(step.bytes.length);
        }
        if ("eof" in step) return Promise.resolve(null);
        if ("fire" in step) {
          signals.get(step.fire)?.();
          continue;
        }
        const handlers = [...timers.values()];
        timers.clear();
        for (const h of handlers) h();
      }
    },
    setRaw(mode) {
      // Throw only on the cleanup setRaw(false); the startup setRaw(true) is
      // not guarded, so a startup throw would escape.
      if (opts.setRawThrows && !mode) throw new Error("setRaw failed");
    },
    close() {
      if (opts.closeThrows) throw new Error("close failed");
    },
  };

  const deps: PagerDeps = {
    openTty: () => {
      if (opts.openThrows) throw new Error("no controlling terminal");
      return tty;
    },
    write: (t) => writes.push(t),
    consoleSize: () => {
      if (opts.consoleSizeThrows) throw new Error("no console");
      return opts.consoleSize ?? { columns: 80, rows: 24 };
    },
    env: (k) => opts.env?.[k],
    addSignalListener: (s, h) => {
      if (opts.addSignalThrowsFor === s) throw new Error("unsupported");
      signals.set(s, h);
    },
    removeSignalListener: (s) => {
      if (opts.removeSignalThrows) throw new Error("remove failed");
      removed.push(s);
    },
    exit: (code) => {
      exited.push(code);
      throw new ExitSignal(code);
    },
    setTimer: (h) => {
      const id = nextTimer++;
      timers.set(id, h);
      return () => timers.delete(id);
    },
  };
  return { deps, writes, signals, removed, timers, exited };
}

Deno.test("pager: a missing /dev/tty raises a ViewError", async () => {
  const { deps } = makeFake({ openThrows: true });
  await assertRejects(
    () => runPager(DOC, OPTS, undefined, undefined, deps),
    ViewError,
    "/dev/tty",
  );
});

Deno.test("pager: draws the document and quits on q", async () => {
  const { deps, writes } = makeFake({ steps: [{ bytes: enc("q") }] });
  await runPager(DOC, OPTS, undefined, undefined, deps);
  assert(writes.length > 0, "wrote frames");
  // The alt screen is entered on start and left on cleanup.
  assert(writes.some((w) => w.includes("\x1b[?1049h")), "entered alt screen");
  assert(writes.some((w) => w.includes("\x1b[?1049l")), "left alt screen");
});

Deno.test("pager: with colour, matches the terminal background to the status bar and restores it", async () => {
  // A redraw (the 'j' scroll) in its own read precedes the quit, so the frame is
  // drawn again inside the loop.
  const { deps, writes } = makeFake({
    steps: [{ bytes: enc("j") }, { bytes: enc("q") }],
  });
  await runPager(
    DOC,
    { color: true, showLineNumbers: false },
    undefined,
    undefined,
    deps,
  );
  const all = writes.join("");
  const set = term.setDefaultBg(ui.statusBar.bg!);
  // OSC 11 sets the terminal default background to the status bar colour, and it
  // is re-asserted on every frame so a terminal that drops it cannot leave a
  // strip in its own colour; OSC 111 restores it on exit.
  assert(all.includes(set), "set the default background");
  assert(all.split(set).length - 1 >= 2, "re-asserted on redraw");
  assert(all.includes("\x1b]111\x07"), "restored the default background");
});

Deno.test("pager: a closed terminal (EOF) ends the loop", async () => {
  const { deps } = makeFake({ steps: [{ eof: true }] });
  await runPager(DOC, OPTS, undefined, undefined, deps);
});

Deno.test("pager: a keystroke split across reads is stitched back together", async () => {
  // 'λ' is CE BB; the lead byte arrives alone, so it is held over and joined
  // with the continuation byte on the next read (exercising concat).
  const { deps } = makeFake({
    steps: [
      { bytes: new Uint8Array([0xce]) },
      { bytes: new Uint8Array([0xbb]) },
      { bytes: enc("q") },
    ],
  });
  await runPager(DOC, OPTS, undefined, undefined, deps);
});

Deno.test("pager: SIGWINCH resizes the session and redraws", async () => {
  const { deps } = makeFake({
    steps: [{ fire: "SIGWINCH" }, { bytes: enc("q") }],
    consoleSize: { columns: 100, rows: 40 },
  });
  await runPager(DOC, OPTS, undefined, undefined, deps);
});

Deno.test("pager: SIGINT on a clean buffer terminates with code 130", async () => {
  const { deps, exited } = makeFake({ steps: [{ fire: "SIGINT" }] });
  await assertRejects(
    () => runPager(DOC, OPTS, undefined, undefined, deps),
    ExitSignal,
  );
  assertEquals(exited, [130]);
});

Deno.test("pager: SIGTERM terminates with code 143", async () => {
  const { deps, exited } = makeFake({ steps: [{ fire: "SIGTERM" }] });
  await assertRejects(
    () => runPager(DOC, OPTS, undefined, undefined, deps),
    ExitSignal,
  );
  assertEquals(exited, [143]);
});

Deno.test("pager: SIGWINCH that the platform rejects is ignored", async () => {
  const { deps } = makeFake({
    steps: [{ bytes: enc("q") }],
    addSignalThrowsFor: "SIGWINCH",
  });
  await runPager(DOC, OPTS, undefined, undefined, deps);
});

Deno.test("pager: cleanup tolerates setRaw and close failing", async () => {
  const { deps } = makeFake({
    steps: [{ bytes: enc("q") }],
    setRawThrows: true,
    closeThrows: true,
  });
  await runPager(DOC, OPTS, undefined, undefined, deps);
});

Deno.test("pager: removeSignalListener failing during cleanup is ignored", async () => {
  const { deps } = makeFake({
    steps: [{ bytes: enc("q") }],
    removeSignalThrows: true,
  });
  await runPager(DOC, OPTS, undefined, undefined, deps);
});

Deno.test("pager: the size falls back to the environment when consoleSize throws", async () => {
  const { deps } = makeFake({
    steps: [{ bytes: enc("q") }],
    consoleSizeThrows: true,
    env: { COLUMNS: "120", LINES: "50" },
  });
  await runPager(DOC, OPTS, undefined, undefined, deps);
});

Deno.test("pager: the size falls back to 80x24 when neither console nor env give one", async () => {
  const { deps } = makeFake({
    steps: [{ bytes: enc("q") }],
    consoleSizeThrows: true,
  });
  await runPager(DOC, OPTS, undefined, undefined, deps);
});

function editableDoc(): {
  doc: typeof DOC;
  source: ReturnType<typeof fileSource>;
  dir: string;
  /** How many times the source has been re-parsed — the deferred reparse calls
   * `source.parse`, so this stays 0 unless an edit actually scheduled and ran
   * one. */
  parses: () => number;
} {
  const dir = Deno.makeTempDirSync();
  const path = join(dir, "m.ts");
  const text = "export const a = 1;\nconst b = a;\n";
  Deno.writeTextFileSync(path, text);
  const base = fileSource(path);
  let parses = 0;
  const source = {
    ...base,
    parse: (t: string) => {
      parses++;
      return base.parse(t);
    },
  };
  return { doc: parseDocument(text, path), source, dir, parses: () => parses };
}

Deno.test("pager: an edit schedules the deferred reparse, which then runs", async () => {
  const { doc, source, dir, parses } = editableDoc();
  try {
    const { deps, writes } = makeFake({
      steps: [
        { bytes: enc("e") }, // e: enter edit mode
        { bytes: enc("X") }, // type — marks needsReparse, schedules the timer
        { fireTimers: true }, // the debounce fires: reparse + redraw
        { eof: true },
      ],
    });
    await runPager(doc, OPTS, undefined, source, deps);
    const out = writes.join("");
    // If e no longer entered edit mode, X would be an inert pager key: no edit
    // hint, no inserted character, and no reparse.
    assert(out.includes("Esc Done"), "e entered edit mode (edit hints shown)");
    assert(out.includes("Xexport"), "the typed X was inserted at the top");
    assertEquals(parses(), 1, "the deferred reparse re-parsed the edited text");
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test("pager: a second edit reschedules the reparse; a pending timer is cleared on exit", async () => {
  const { doc, source, dir, parses } = editableDoc();
  try {
    const { deps, writes } = makeFake({
      steps: [
        { bytes: enc("e") }, // e: enter edit mode
        { bytes: enc("X") }, // schedules timer 1
        { bytes: enc("Y") }, // reschedules: clears timer 1, schedules timer 2
        { eof: true }, // exit with timer 2 still pending -> cleared in finally
      ],
    });
    await runPager(doc, OPTS, undefined, source, deps);
    const out = writes.join("");
    // Both edits must have landed for there to be a reparse to reschedule.
    assert(out.includes("Esc Done"), "e entered edit mode");
    assert(out.includes("XYexport"), "both typed edits were inserted");
    // The pending reparse timer was cleared on exit before it could fire.
    assertEquals(parses(), 0, "the rescheduled reparse never ran");
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test("pager: a SIGINT with unsaved edits routes through the save prompt", async () => {
  const { doc, source, dir } = editableDoc();
  try {
    const { deps, writes } = makeFake({
      steps: [
        { bytes: enc("e") }, // enter edit mode
        { bytes: enc("X") }, // an unsaved edit
        { fire: "SIGINT" }, // requestQuitFromSignal is true -> redraw, no exit
        { eof: true },
      ],
    });
    await runPager(doc, OPTS, undefined, source, deps);
    // The dirty buffer is what makes the SIGINT redraw the save prompt instead
    // of exiting; without the edit landing, the prompt would never appear.
    assert(
      writes.join("").includes("Save changes to"),
      "the SIGINT raised the save-prompt dialog over the dirty buffer",
    );
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test("realPagerDeps: the wrappers reach the real primitives", () => {
  const d = realPagerDeps();
  d.write(""); // writes nothing to stdout
  d.env("PATH");
  d.env("CF_VIEW_DEFINITELY_UNSET");
  const cancel = d.setTimer(() => {}, 0);
  cancel();
  // Opening the controlling terminal either succeeds (close it) or throws when
  // the test has none; both reach the wrapper.
  try {
    d.openTty().close();
  } catch { /* no controlling terminal in this environment */ }
});
