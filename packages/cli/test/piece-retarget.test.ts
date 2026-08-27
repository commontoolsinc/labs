/**
 * `cf piece retarget`'s command action and its `runRetarget` seam: the plan
 * intake, the report's one destination in each of its three modes, the
 * per-row line as the run proceeds, the exit discipline, and the session
 * supply the seam hands the library — opened per group and disposed at every
 * boundary.
 */

import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { PiecesController } from "@commonfabric/piece/ops";
import type {
  ApplyReport,
  ApplySessions,
  RetargetOptions,
} from "@commonfabric/piece/ops/bulk-retarget";
import { decode } from "@commonfabric/utils/encoding";

import { runRetarget } from "../lib/bulk.ts";
import {
  formatApplyRow,
  piece,
  retargetFromCommand,
  setQuietMode,
} from "../commands/piece.ts";

function captureStdout(fn: () => Promise<void>): Promise<string> {
  let captured = "";
  const original = Deno.stdout.writeSync;
  Deno.stdout.writeSync = (data: Uint8Array): number => {
    captured += decode(data);
    return data.length;
  };
  return fn().then(() => captured).finally(() => {
    Deno.stdout.writeSync = original;
  });
}

class ExitSentinel extends Error {}

/** The engine option shape this seam forwards; only `accepted` is read. */
interface ApplyOptionsLike {
  accepted?: readonly string[];
}

const OPTIONS = {
  apiUrl: "http://localhost:8000",
  identity: "/tmp/test-identity.pem",
  space: "home",
  quiet: true,
  plan: "plan.jsonl",
};

// The 43-character handle length clears the canonical parser's threshold
// below which an id reads as a human name and is refused.
const HANDLE = "baedreiabcdefghijklmnopqrstuvwxyz0123456789";

const PLAN_TEXT = [
  JSON.stringify({
    kind: "piece-plan",
    v: 1,
    space: "did:key:test",
    takenAt: "2026-08-25T00:00:00.000Z",
    selector: "collection",
    enumerated: { collection: 1, registry: 0, registeredOutside: 0 },
  }),
  JSON.stringify({
    piece: `fid1:${HANDLE}`,
    phase: "items",
    expect: { patternIdentity: "idA", symbol: "Member", retained: true },
    op: {
      kind: "retarget",
      patternIdentity: "idB",
      symbol: "Member",
      source: { main: "/sources/member-v2.tsx", mainExport: "Member" },
    },
  }),
  "",
].join("\n");

const REPORT: ApplyReport = {
  rows: [
    { piece: "fid1:aaa", phase: "items", verdict: "applied", elapsedMs: 412 },
    { piece: "fid1:bbb", phase: "items", verdict: "landed", elapsedMs: 18 },
  ],
  applied: 1,
  complete: true,
};

describe("piece-retarget", () => {
  // The fixtures pass `quiet`, and the action applies it globally.
  afterEach(() => setQuietMode(false));

  describe("formatApplyRow()", () => {
    it("puts the verdict, the piece, its phase, and its cost on one line", () => {
      expect(formatApplyRow(REPORT.rows[0])).toBe(
        "applied fid1:aaa items 412ms",
      );
    });

    it("labels a row with no write as carrying the plan's recorded origin", () => {
      const origin = "https://origins.test/member.tsx";
      // No write happened, so the plan's reading is the only value there is
      // — and the line says whose reading it is rather than claiming a
      // detach.
      expect(
        formatApplyRow({
          piece: "fid1:aaa",
          phase: "items",
          verdict: "outstanding",
          origin,
        }),
      ).toBe(`outstanding fid1:aaa items origin ${origin}`);
    });

    it("states what an applied row detached, and stays quiet when the plan agreed", () => {
      const origin = "https://origins.test/member.tsx";
      expect(
        formatApplyRow({ ...REPORT.rows[0], origin, detachedOrigin: origin }),
      ).toBe(`applied fid1:aaa items 412ms detached ${origin}`);
    });

    it("names both origins on an applied row whose plan had gone stale", () => {
      const recorded = "https://origins.test/recorded.tsx";
      const live = "https://origins.test/live.tsx";
      // The operator re-attaches from what was detached; the recorded value
      // rides along because a plan that disagrees with the run is a plan
      // they must not re-attach from.
      expect(
        formatApplyRow({
          ...REPORT.rows[0],
          origin: recorded,
          detachedOrigin: live,
        }),
      ).toBe(
        `applied fid1:aaa items 412ms detached ${live} ` +
          `(plan recorded ${recorded})`,
      );
      // The write found the piece already detached: nothing was detached,
      // and saying so is what keeps the recorded value from reading as one.
      expect(formatApplyRow({ ...REPORT.rows[0], origin: recorded })).toBe(
        `applied fid1:aaa items 412ms detached nothing ` +
          `(plan recorded ${recorded})`,
      );
    });

    it("carries what a row broke, and omits what a row does not have", () => {
      expect(
        formatApplyRow({
          piece: "fid1:ccc",
          verdict: "refused",
          problem: "The source resolves to idC, not the idB this row recorded.",
        }),
      ).toBe(
        "refused fid1:ccc - The source resolves to idC, not the idB this " +
          "row recorded.",
      );
    });
  });

  describe("retargetFromCommand()", () => {
    it("prints a line per row as each row settles", async () => {
      const hints: string[] = [];
      const printed: unknown[] = [];
      const printedWhenSettled: number[] = [];
      await retargetFromCommand(OPTIONS, {
        render: (value) => {
          printed.push(value);
        },
        runRetarget: (_config, request) => {
          for (const row of REPORT.rows) {
            request.onRow?.(row);
            printedWhenSettled.push(printed.length);
          }
          return Promise.resolve(REPORT);
        },
        printHint: (message) => {
          hints.push(message);
        },
      });
      expect(printed).toEqual([
        "applied fid1:aaa items 412ms",
        "landed fid1:bbb items 18ms",
      ]);
      // One line out by the time each row settled: a report assembled first
      // and printed at the end would satisfy the assertion above and none of
      // what it exists for.
      expect(printedWhenSettled).toEqual([1, 2]);
      expect(hints).toEqual(["applied: 1 · landed: 1 · written: 1"]);
    });

    it("names each row that landed with a warning", async () => {
      const hints: string[] = [];
      const warned: ApplyReport = {
        rows: [
          { ...REPORT.rows[0], warning: "the piece ran with a warning" },
          REPORT.rows[1],
        ],
        applied: 1,
        complete: true,
      };
      await captureStdout(() =>
        retargetFromCommand(OPTIONS, {
          runRetarget: () => Promise.resolve(warned),
          printHint: (message) => {
            hints.push(message);
          },
        })
      );
      // A warned row landed, so it is not among the stopped rows the exit
      // message names; the hint is the only place a human reads it.
      expect(hints).toContain(
        "applied: fid1:aaa warned: the piece ran with a warning",
      );
    });

    it("names the rows this run detached, counting no row it did not write", async () => {
      const hints: string[] = [];
      // The landed row carries the origin its plan recorded and was NOT
      // written by this run — the piece was already on its target. Counting
      // it would claim a detach that did not happen here, so the count comes
      // off what the writes observed rather than off the recorded value.
      const following: ApplyReport = {
        rows: [
          {
            ...REPORT.rows[0],
            origin: "https://origins.test/member.tsx",
            detachedOrigin: "https://origins.test/member.tsx",
          },
          { ...REPORT.rows[1], origin: "https://origins.test/other.tsx" },
        ],
        applied: 1,
        complete: true,
      };
      await captureStdout(() =>
        retargetFromCommand({ ...OPTIONS, apply: true }, {
          runRetarget: () => Promise.resolve(following),
          printHint: (message) => {
            hints.push(message);
          },
        })
      );
      expect(hints).toContain(
        "detached from an origin: 1 of 2 rows; the report names each " +
          "origin, and re-attaching is by hand.",
      );
      expect(hints.some((hint) => hint.includes("would detach"))).toBe(false);
      // The plan agreed with the write, so there is nothing stale to say.
      expect(hints.some((hint) => hint.includes("not what the write"))).toBe(
        false,
      );
    });

    it("names the rows whose recorded origin was not what the write detached", async () => {
      const hints: string[] = [];
      const stale: ApplyReport = {
        rows: [
          {
            ...REPORT.rows[0],
            origin: "https://origins.test/recorded.tsx",
            detachedOrigin: "https://origins.test/live.tsx",
          },
          { ...REPORT.rows[1], origin: "https://origins.test/other.tsx" },
        ],
        applied: 1,
        complete: true,
      };
      await captureStdout(() =>
        retargetFromCommand({ ...OPTIONS, apply: true }, {
          runRetarget: () => Promise.resolve(stale),
          printHint: (message) => {
            hints.push(message);
          },
        })
      );
      // An operator re-attaching from the plan file would restore an origin
      // this run never touched, so the run says which file to work from.
      expect(hints).toContain(
        "the plan's recorded origin was not what the write detached on 1 " +
          "of 2 rows; re-attach from this report rather than from the plan.",
      );
    });

    it("names the rows an apply would detach when nothing was written", async () => {
      const hints: string[] = [];
      // The dry run: no row was written, so the only true claim is the
      // conditional one — and the landed row is excluded there too, an
      // apply of this plan having nothing left to write for it.
      const dry: ApplyReport = {
        rows: [
          {
            piece: "fid1:aaa",
            phase: "items",
            verdict: "outstanding",
            origin: "https://origins.test/member.tsx",
          },
          {
            piece: "fid1:bbb",
            phase: "items",
            verdict: "landed",
            origin: "https://origins.test/other.tsx",
          },
        ],
        applied: 0,
        complete: true,
      };
      await captureStdout(() =>
        retargetFromCommand(OPTIONS, {
          runRetarget: () => Promise.resolve(dry),
          printHint: (message) => {
            hints.push(message);
          },
        })
      );
      expect(hints).toContain(
        "an apply would detach a recorded origin on 1 of 2 rows; the report " +
          "names each origin, and re-attaching is by hand.",
      );
      expect(hints.some((hint) => hint.startsWith("detached from"))).toBe(
        false,
      );
    });

    it("passes the plan path, the apply flag, and the group size through", async () => {
      let request: { planPath?: string; apply?: boolean; groupSize?: number } =
        {};
      await captureStdout(() =>
        retargetFromCommand({ ...OPTIONS, apply: true, groupSize: 7 }, {
          runRetarget: (_config, req) => {
            request = req;
            return Promise.resolve(REPORT);
          },
          printHint: () => {},
        })
      );
      expect(request.planPath?.endsWith("/plan.jsonl")).toBe(true);
      expect(request.apply).toBe(true);
      expect(request.groupSize).toBe(7);
    });

    it("keeps the runtime's console off stdout in every mode", async () => {
      let jsonOutput: boolean | undefined;
      await captureStdout(() =>
        retargetFromCommand(OPTIONS, {
          runRetarget: (config) => {
            jsonOutput = (config as { jsonOutput?: boolean }).jsonOutput;
            return Promise.resolve(REPORT);
          },
          printHint: () => {},
        })
      );
      // Not only under --json: this run starts the pieces it writes, and a
      // pattern's own logging would land between two rows of the stream.
      expect(jsonOutput).toBe(true);
    });

    it("emits the whole report as one canonical document under --json", async () => {
      const out = await captureStdout(() =>
        retargetFromCommand({ ...OPTIONS, json: true }, {
          runRetarget: (_config, request) => {
            // A single document cannot stream, so no row reporter is handed
            // to the library at all.
            expect(Object.keys(request).sort()).toEqual(["planPath"]);
            return Promise.resolve(REPORT);
          },
          printHint: () => {},
        })
      );
      expect(out.startsWith("fvj1:")).toBe(true);
      expect(out).toContain('"elapsedMs":412');
    });

    it("writes the report to --out and leaves stdout empty", async () => {
      let written: { path: string; text: string } | undefined;
      const hints: string[] = [];
      const out = await captureStdout(() =>
        retargetFromCommand({ ...OPTIONS, out: "report.json" }, {
          runRetarget: (_config, request) => {
            expect(Object.keys(request).sort()).toEqual(["planPath"]);
            return Promise.resolve(REPORT);
          },
          writeTextFile: (path, text) => {
            written = { path: String(path), text: String(text) };
            return Promise.resolve();
          },
          printHint: (message) => {
            hints.push(message);
          },
        })
      );
      expect(out).toBe("");
      expect(written?.path).toBe("report.json");
      expect(written?.text.startsWith("fvj1:")).toBe(true);
      expect(written?.text.endsWith("\n")).toBe(true);
      expect(hints).toContain("Wrote 2 report rows to report.json");
    });

    it("exits nonzero on a stopped run, naming every unattempted piece", async () => {
      const errors: string[] = [];
      const stopped: ApplyReport = {
        rows: [
          { piece: "fid1:aaa", verdict: "applied", elapsedMs: 5 },
          {
            piece: "fid1:bbb",
            verdict: "refused",
            problem: "The source resolves to idC, not the idB this row " +
              "recorded.",
            elapsedMs: 3,
          },
          { piece: "fid1:ccc", verdict: "unattempted" },
          { piece: "fid1:ddd", verdict: "unattempted" },
        ],
        applied: 1,
        complete: false,
      };
      await expect(
        captureStdout(() =>
          retargetFromCommand({ ...OPTIONS, apply: true }, {
            runRetarget: () => Promise.resolve(stopped),
            printHint: () => {},
            printError: (message) => {
              errors.push(message);
            },
            exit: (code) => {
              expect(code).toBe(1);
              throw new ExitSentinel();
            },
          })
        ),
      ).rejects.toThrow(ExitSentinel);
      const message = errors.join("\n");
      expect(message).toContain("Retarget did not complete");
      // Each unattempted piece by name, never a count of them.
      expect(message).toContain("  unattempted: fid1:ccc");
      expect(message).toContain("  unattempted: fid1:ddd");
      expect(message).toContain("  refused: fid1:bbb The source resolves");
      expect(message).not.toContain("fid1:aaa");
    });

    it("names the run's own stop reason when no piece is at fault", async () => {
      const errors: string[] = [];
      await expect(
        captureStdout(() =>
          retargetFromCommand({ ...OPTIONS, apply: true }, {
            runRetarget: () =>
              Promise.resolve({
                rows: [{ piece: "fid1:aaa", verdict: "unattempted" }],
                applied: 0,
                complete: false,
                stopReason: "The plan names space did:key:test; this run " +
                  "targets did:key:other.",
              } as ApplyReport),
            printHint: () => {},
            printError: (message) => {
              errors.push(message);
            },
            exit: () => {
              throw new ExitSentinel();
            },
          })
        ),
      ).rejects.toThrow(ExitSentinel);
      expect(errors.join("\n")).toContain(
        "  stopped: The plan names space did:key:test",
      );
    });

    it("holds a dry run's outstanding rows against nothing", async () => {
      const hints: string[] = [];
      const out = await captureStdout(() =>
        retargetFromCommand(OPTIONS, {
          runRetarget: (_config, request) => {
            expect(Object.keys(request).sort()).toEqual([
              "onRow",
              "planPath",
            ]);
            const dry: ApplyReport = {
              rows: [{
                piece: "fid1:aaa",
                phase: "items",
                verdict: "outstanding",
              }],
              applied: 0,
              complete: true,
            };
            request.onRow?.(dry.rows[0]);
            return Promise.resolve(dry);
          },
          printHint: (message) => {
            hints.push(message);
          },
          exit: () => {
            throw new ExitSentinel();
          },
        })
      );
      expect(out).toBe("outstanding fid1:aaa items\n");
      expect(hints).toEqual(["outstanding: 1 · written: 0"]);
    });

    it("exits nonzero on a dry run that found a row an apply would refuse", async () => {
      const errors: string[] = [];
      await expect(
        captureStdout(() =>
          retargetFromCommand(OPTIONS, {
            runRetarget: () =>
              Promise.resolve({
                rows: [
                  { piece: "fid1:aaa", verdict: "outstanding" },
                  {
                    piece: "fid1:bbb",
                    verdict: "moved-elsewhere",
                    problem: "The piece is on idC#Member.",
                  },
                ],
                applied: 0,
                complete: false,
              } as ApplyReport),
            printHint: () => {},
            printError: (message) => {
              errors.push(message);
            },
            exit: () => {
              throw new ExitSentinel();
            },
          })
        ),
      ).rejects.toThrow(ExitSentinel);
      const message = errors.join("\n");
      expect(message).toContain("Retarget found rows an apply would refuse.");
      expect(message).toContain("  moved-elsewhere: fid1:bbb");
      // A dry run's outstanding row is that run's answer, not its defect.
      expect(message).not.toContain("fid1:aaa");
    });

    it("names every accepted piece where quiet cannot silence it", async () => {
      // The acceptance is recorded at the only moment it is still a
      // decision — before the move — so it goes to the note rather than a
      // hint, which `--quiet` would silence.
      const notes: string[] = [];
      const hints: string[] = [];
      let accepted: readonly string[] | undefined;
      await captureStdout(() =>
        retargetFromCommand(
          { ...OPTIONS, apply: true, acceptUnretained: ["fid1:aaa"] },
          {
            runRetarget: (_config, request) => {
              accepted = request.accept;
              return Promise.resolve(REPORT);
            },
            printHint: (message) => {
              hints.push(message);
            },
            printNote: (message) => {
              notes.push(message);
            },
          },
        )
      );
      expect(accepted).toEqual(["fid1:aaa"]);
      expect(notes).toEqual([
        "accepted as unrollbackable: fid1:aaa (moving it leaves no reversal)",
      ]);
      expect(hints.join("\n")).not.toContain("unrollbackable");
    });

    it("routes cf piece retarget to retargetFromCommand", () => {
      const registered = piece.getCommand("retarget") as unknown as {
        actionHandler?: unknown;
      };
      expect(registered?.actionHandler).toBe(retargetFromCommand);
    });
  });

  describe("runRetarget()", () => {
    it("decodes the plan file and passes the run's knobs to the library", async () => {
      let options: RetargetOptions | undefined;
      const report = await runRetarget({} as never, {
        planPath: "/plans/upgrade.jsonl",
        apply: true,
        groupSize: 4,
        onRow: () => {},
      }, {
        readTextFile: (path) => {
          expect(path).toBe("/plans/upgrade.jsonl");
          return Promise.resolve(PLAN_TEXT);
        },
        retargetPieces: (_sessions, given) => {
          options = given;
          return Promise.resolve(REPORT);
        },
      });
      expect(report).toBe(REPORT);
      expect(options?.plan.header.space).toBe("did:key:test");
      expect(options?.plan.rows[0].op).toEqual({
        kind: "retarget",
        patternIdentity: "idB",
        symbol: "Member",
        source: { main: "/sources/member-v2.tsx", mainExport: "Member" },
      });
      expect(options?.apply).toBe(true);
      expect(options?.groupSize).toBe(4);
      expect(options?.onRow).toBeDefined();
    });

    it("passes the named acceptances through to the library", async () => {
      let options: ApplyOptionsLike | undefined;
      await runRetarget({} as never, {
        planPath: "/plans/upgrade.jsonl",
        accept: ["fid1:aaa"],
        apply: true,
      }, {
        readTextFile: () => Promise.resolve(PLAN_TEXT),
        retargetPieces: (_sessions, given) => {
          options = given as unknown as ApplyOptionsLike;
          return Promise.resolve(REPORT);
        },
      });
      expect(options?.accepted).toEqual(["fid1:aaa"]);
    });

    it("omits the knobs the command did not ask for", async () => {
      let options: RetargetOptions | undefined;
      await runRetarget({} as never, { planPath: "/plans/upgrade.jsonl" }, {
        readTextFile: () => Promise.resolve(PLAN_TEXT),
        retargetPieces: (_sessions, given) => {
          options = given;
          return Promise.resolve(REPORT);
        },
      });
      // The key set, not each value: an `apply: undefined` riding along is
      // a key the library still has to reason about, and every matcher that
      // asks about one property — `toBeUndefined`, and `toHaveProperty` in
      // this library too — reads a present-but-undefined key as an absent
      // one. Only the keys themselves tell the two apart.
      expect(Object.keys(options ?? {})).toEqual(["plan"]);
    });

    it("settles and disposes each session it is handed back", async () => {
      const opened: unknown[] = [];
      const settled: unknown[] = [];
      const disposed: unknown[] = [];
      const config = { space: "home" } as never;
      await runRetarget(config, { planPath: "/plans/upgrade.jsonl" }, {
        readTextFile: () => Promise.resolve(PLAN_TEXT),
        loadPieces: (given) => {
          expect(given).toBe(config);
          const controller = {
            synced: () => {
              settled.push(controller);
              return Promise.resolve();
            },
            dispose: () => {
              // Settling comes first: disposal closes the storage this
              // session's reads are still going through.
              expect(settled).toContain(controller);
              disposed.push(controller);
              return Promise.resolve();
            },
          } as unknown as PiecesController;
          opened.push(controller);
          return Promise.resolve(controller);
        },
        retargetPieces: async (sessions: ApplySessions) => {
          // Two groups, each released at its boundary: the run holds one
          // session at a time rather than accumulating them.
          await sessions.close(await sessions.open());
          await sessions.close(await sessions.open());
          return REPORT;
        },
      });
      expect(opened.length).toBe(2);
      expect(disposed).toEqual(opened);
    });

    it("disposes a session whose settle failed, and reports the stop", async () => {
      let disposed = 0;
      const report = await runRetarget(
        {} as never,
        { planPath: "/plans/upgrade.jsonl" },
        {
          readTextFile: () => Promise.resolve(PLAN_TEXT),
          loadPieces: () =>
            Promise.resolve(
              {
                getSpace: () => "did:key:test",
                get: () =>
                  Promise.reject(new Error("this session reads no pieces")),
                synced: () =>
                  Promise.reject(new Error("the group's writes never landed")),
                dispose: () => {
                  disposed += 1;
                  return Promise.resolve();
                },
              } as unknown as PiecesController,
            ),
        },
      );
      // A settle that rejects must not take the disposal with it: the
      // library turns the boundary's failure into a stop rather than a
      // crash, so a session skipped here would stay open for the rest of
      // the process.
      expect(disposed).toBe(1);
      expect(report.complete).toBe(false);
      expect(report.applied).toBe(0);
      expect(report.stopReason).toContain("the group's writes never landed");
      expect(report.stopReason).toContain(
        "the preflight session could not be released",
      );
      expect(report.stopReason).not.toContain("could not be disposed");
    });

    it("names the settle failure ahead of a disposal that failed too", async () => {
      const report = await runRetarget(
        {} as never,
        { planPath: "/plans/upgrade.jsonl" },
        {
          readTextFile: () => Promise.resolve(PLAN_TEXT),
          loadPieces: () =>
            Promise.resolve(
              {
                getSpace: () => "did:key:test",
                get: () =>
                  Promise.reject(new Error("this session reads no pieces")),
                synced: () =>
                  Promise.reject(new Error("the group's writes never landed")),
                dispose: () =>
                  Promise.reject(new Error("the runtime would not shut down")),
              } as unknown as PiecesController,
            ),
        },
      );
      // The settle failure leads: it is why the boundary cannot be trusted.
      // The disposal that failed after it is named too, never instead.
      const stop = report.stopReason ?? "";
      // One period joins the two sentences: the settle message carries none
      // of its own, so the composition must supply it.
      expect(stop).toContain(
        "the group's writes never landed. Its session could not be " +
          "disposed either: the runtime would not shut down.",
      );
      expect(stop.indexOf("never landed")).toBeLessThan(
        stop.indexOf("could not be disposed"),
      );
    });
  });
});
