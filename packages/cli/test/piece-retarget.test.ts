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
  RetargetOptions,
  RetargetReport,
  RetargetSessions,
} from "@commonfabric/piece/ops/bulk-retarget";
import { decode } from "@commonfabric/utils/encoding";

import { runRetarget } from "../lib/bulk.ts";
import {
  formatRetargetRow,
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

const REPORT: RetargetReport = {
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

  describe("formatRetargetRow()", () => {
    it("puts the verdict, the piece, its phase, and its cost on one line", () => {
      expect(formatRetargetRow(REPORT.rows[0])).toBe(
        "applied fid1:aaa items 412ms",
      );
    });

    it("carries what a row broke, and omits what a row does not have", () => {
      expect(
        formatRetargetRow({
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
      const stopped: RetargetReport = {
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
              } as RetargetReport),
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
            const dry: RetargetReport = {
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
              } as RetargetReport),
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
        retargetPieces: async (sessions: RetargetSessions) => {
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
