import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import type { PatternCompatibilityReport } from "@commonfabric/piece/ops";
import type { PiecesController } from "@commonfabric/piece/ops";
import type { RuntimeProgram } from "@commonfabric/runner";

import {
  batchApplyNextSteps,
  batchCheckNextSteps,
  checkPieceSourceBatchFromCommand,
  formatBatchOutcomeLine,
  formatBatchStopReport,
  formatBatchSummary,
  parseBatchPieceConfigs,
  setPieceSourceBatchFromCommand,
  setSrcBatchAction,
} from "../commands/piece.ts";
import {
  type BatchPieceOutcome,
  checkPiecePatternBatch,
  type PieceConfig,
  setPiecePatternBatch,
  type SpaceConfig,
} from "../lib/piece.ts";

const API_URL = "https://cf.dev";
const SPACE = "common-knowledge";
const IDENTITY = "/tmp/test.key";
const SPACE_DID = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";
const OTHER_SPACE_DID =
  "did:key:z6MkrZ1r5XBFZjBU34qyD8fueMbMRkKw17BZaq2ivKFjnz2z";

const CANDIDATE = { identity: "C".repeat(43), symbol: "default" };

const PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{ name: "/main.tsx", contents: "export default 1;" }],
};

const ENTRY = {
  mainPath: "/repo/pattern.tsx",
  repository: "https://github.com/commontoolsinc/labs",
};

function configFor(piece: string, extra: Partial<PieceConfig> = {}) {
  return {
    apiUrl: API_URL,
    space: SPACE,
    identity: IDENTITY,
    piece,
    ...extra,
  } as PieceConfig;
}

/** What one fake piece looks like to the batch. */
interface FakePieceSpec {
  deployed?: { identity: string; symbol: string };
  setPatternError?: Error;
  report?: PatternCompatibilityReport;
}

interface BatchCallLog {
  loadConfigs: SpaceConfig[];
  pinnedEntries: unknown[];
  setPatternCalls: { piece: string; program: unknown; options: unknown }[];
  checkPatternCalls: { piece: string; program: unknown }[];
}

function newBatchCallLog(): BatchCallLog {
  return {
    loadConfigs: [],
    pinnedEntries: [],
    setPatternCalls: [],
    checkPatternCalls: [],
  };
}

/**
 * A fake `PiecesController` covering exactly the surface the batch functions
 * touch: `get()` for the per-piece controllers and each piece operation.
 */
function fakePieces(
  specs: Record<string, FakePieceSpec>,
  log: BatchCallLog,
): PiecesController {
  return {
    get: (pieceId: string) => {
      const spec = specs[pieceId];
      if (spec === undefined) {
        return Promise.reject(new Error(`no such piece: ${pieceId}`));
      }
      return Promise.resolve({
        getCell: () => ({
          getMetaRaw: (key: string) =>
            key === "patternIdentity" ? spec.deployed : undefined,
        }),
        setPattern: (program: unknown, options: unknown) => {
          log.setPatternCalls.push({ piece: pieceId, program, options });
          return spec.setPatternError === undefined
            ? Promise.resolve()
            : Promise.reject(spec.setPatternError);
        },
        checkPattern: (program: unknown) => {
          log.checkPatternCalls.push({ piece: pieceId, program });
          return Promise.resolve(spec.report);
        },
      });
    },
  } as unknown as PiecesController;
}

function batchDeps(
  specs: Record<string, FakePieceSpec>,
  log: BatchCallLog,
  overrides: Record<string, unknown> = {},
) {
  const pieces = fakePieces(specs, log);
  return {
    loadPieces: (config: SpaceConfig) => {
      log.loadConfigs.push(config);
      return Promise.resolve(pieces);
    },
    getPinnedProgramFromFile: (_pieces: PiecesController, entry: unknown) => {
      log.pinnedEntries.push(entry);
      return Promise.resolve(PROGRAM);
    },
    resolvePieceAddress: (_pieces: PiecesController, token: string) =>
      Promise.resolve(token),
    ...overrides,
  };
}

function compatibleReport(): PatternCompatibilityReport {
  return { compatible: true, issues: {}, candidate: CANDIDATE };
}

function incompatibleReport(message: string): PatternCompatibilityReport {
  return {
    compatible: false,
    issues: { schema: message },
    message,
    candidate: CANDIDATE,
  };
}

describe("piece-setsrc-batch", () => {
  describe("setPiecePatternBatch()", () => {
    it("updates every piece serially in the order given, through one session and one pinned program", async () => {
      const log = newBatchCallLog();
      const outcomes: [BatchPieceOutcome, number, number][] = [];
      const result = await setPiecePatternBatch(
        [configFor("p1"), configFor("p2"), configFor("p3")],
        ENTRY,
        {},
        {
          ...batchDeps({ p1: {}, p2: {}, p3: {} }, log),
          onOutcome: (outcome, index, total) =>
            outcomes.push([outcome, index, total]),
        },
      );

      expect(result).toEqual([
        { piece: "p1" },
        { piece: "p2" },
        { piece: "p3" },
      ]);
      expect(outcomes).toEqual([
        [{ piece: "p1" }, 0, 3],
        [{ piece: "p2" }, 1, 3],
        [{ piece: "p3" }, 2, 3],
      ]);
      expect(log.setPatternCalls.map((call) => call.piece)).toEqual([
        "p1",
        "p2",
        "p3",
      ]);
      // One session and one resolved source package pay for the whole batch.
      expect(log.loadConfigs.length).toBe(1);
      expect(log.pinnedEntries).toEqual([ENTRY]);
      for (const call of log.setPatternCalls) {
        expect(call.program).toBe(PROGRAM);
        expect(call.options).toEqual({ repository: ENTRY.repository });
      }
    });

    it("applies a piece already running the candidate so setPattern owns its lifecycle and repository updates", async () => {
      const log = newBatchCallLog();
      const result = await setPiecePatternBatch(
        [configFor("p1"), configFor("p2")],
        ENTRY,
        {},
        batchDeps({ p1: { deployed: CANDIDATE }, p2: {} }, log),
      );

      expect(result).toEqual([
        { piece: "p1" },
        { piece: "p2" },
      ]);
      expect(log.setPatternCalls.map((call) => call.piece)).toEqual([
        "p1",
        "p2",
      ]);
      for (const call of log.setPatternCalls) {
        expect(call.options).toEqual({ repository: ENTRY.repository });
      }
    });

    it("stops at the first failing piece, reports what landed, and rethrows that piece's own error", async () => {
      const log = newBatchCallLog();
      const failure = new Error("schema narrowed: label");
      let reported: unknown;
      const attempt = setPiecePatternBatch(
        [configFor("p1"), configFor("p2"), configFor("p3")],
        ENTRY,
        {},
        {
          ...batchDeps(
            { p1: {}, p2: { setPatternError: failure }, p3: {} },
            log,
          ),
          onFailure: (context) => {
            reported = context;
          },
        },
      );

      await expect(attempt).rejects.toBe(failure);
      expect(reported).toEqual({
        piece: "p2",
        index: 1,
        total: 3,
        outcomes: [{ piece: "p1" }],
      });
      // The stop is immediate: the third piece is never attempted.
      expect(log.setPatternCalls.map((call) => call.piece)).toEqual([
        "p1",
        "p2",
      ]);
    });

    it("forwards the dangerous override to every piece's `setPattern`", async () => {
      const log = newBatchCallLog();
      await setPiecePatternBatch(
        [configFor("p1"), configFor("p2")],
        ENTRY,
        { dangerouslyAllowIncompatibleSchema: true },
        batchDeps({ p1: {}, p2: {} }, log),
      );

      for (const call of log.setPatternCalls) {
        expect(call.options).toEqual({
          repository: ENTRY.repository,
          dangerouslyAllowIncompatibleSchema: true,
        });
      }
    });

    it("collects the embedded space DIDs of every piece reference into the one session config", async () => {
      const log = newBatchCallLog();
      await setPiecePatternBatch(
        [
          configFor("p1", { embeddedSpaces: [SPACE_DID] }),
          configFor("p2", { embeddedSpaces: [SPACE_DID, OTHER_SPACE_DID] }),
        ],
        ENTRY,
        {},
        batchDeps({ p1: {}, p2: {} }, log),
      );

      expect(log.loadConfigs.length).toBe(1);
      expect(log.loadConfigs[0].embeddedSpaces).toEqual([
        SPACE_DID,
        OTHER_SPACE_DID,
      ]);
    });

    it("opens the session on the first config when no reference embeds a space", async () => {
      const log = newBatchCallLog();
      const configs = [configFor("p1"), configFor("p2")];
      await setPiecePatternBatch(
        configs,
        ENTRY,
        {},
        batchDeps({ p1: {}, p2: {} }, log),
      );

      expect(log.loadConfigs[0]).toBe(configs[0]);
    });

    it("resolves each piece reference through the session and reports the resolved id", async () => {
      const log = newBatchCallLog();
      const result = await setPiecePatternBatch(
        [configFor("one"), configFor("two")],
        ENTRY,
        {},
        batchDeps({ "one/resolved": {}, "two/resolved": {} }, log, {
          resolvePieceAddress: (_pieces: PiecesController, token: string) =>
            Promise.resolve(`${token}/resolved`),
        }),
      );

      expect(result.map((outcome) => outcome.piece)).toEqual([
        "one/resolved",
        "two/resolved",
      ]);
    });
  });

  describe("checkPiecePatternBatch()", () => {
    it("reviews every piece with the shared pinned program and returns the verdicts in order", async () => {
      const log = newBatchCallLog();
      const good = compatibleReport();
      const bad = incompatibleReport("result narrowed: label");
      const checks = await checkPiecePatternBatch(
        [configFor("p1"), configFor("p2")],
        ENTRY,
        batchDeps({ p1: { report: good }, p2: { report: bad } }, log),
      );

      expect(checks).toEqual([
        { piece: "p1", report: good },
        { piece: "p2", report: bad },
      ]);
      expect(log.loadConfigs.length).toBe(1);
      expect(log.pinnedEntries).toEqual([ENTRY]);
      for (const call of log.checkPatternCalls) {
        expect(call.program).toBe(PROGRAM);
      }
    });
  });

  describe("parseBatchPieceConfigs()", () => {
    it("parses each `--piece` value with the shared space options", () => {
      const configs = parseBatchPieceConfigs({
        apiUrl: API_URL,
        space: SPACE,
        identity: IDENTITY,
        piece: ["p1", "p2"],
      });

      expect(configs).toEqual([
        { apiUrl: API_URL, space: SPACE, identity: IDENTITY, piece: "p1" },
        { apiUrl: API_URL, space: SPACE, identity: IDENTITY, piece: "p2" },
      ]);
    });

    it("combines a piece-less `--url` with every repeated `--piece`", () => {
      expect(parseBatchPieceConfigs({
        url: `${API_URL}/${SPACE}`,
        identity: IDENTITY,
        piece: ["p1", "p2"],
      })).toEqual([
        { apiUrl: API_URL, space: SPACE, identity: IDENTITY, piece: "p1" },
        { apiUrl: API_URL, space: SPACE, identity: IDENTITY, piece: "p2" },
      ]);
    });
  });

  describe("setPieceSourceBatchFromCommand()", () => {
    it("streams one line per piece as it lands, then the summary", async () => {
      const lines: string[] = [];
      let forwarded: unknown;
      const { configs, outcomes } = await setPieceSourceBatchFromCommand(
        {
          apiUrl: API_URL,
          space: SPACE,
          identity: IDENTITY,
          piece: ["p1", "p2"],
          repository: ENTRY.repository,
        },
        "/repo/pattern.tsx",
        {
          setPiecePatternBatch: (configs, entry, options, deps) => {
            forwarded = { configs, entry, options };
            const landed: BatchPieceOutcome[] = [
              { piece: "p1" },
              { piece: "p2" },
            ];
            landed.forEach((outcome, index) =>
              deps?.onOutcome?.(outcome, index, landed.length)
            );
            return Promise.resolve(landed);
          },
          report: (line) => lines.push(line),
        },
      );

      expect(lines).toEqual([
        "Updated source for piece p1 (1/2)",
        "Updated source for piece p2 (2/2)",
        "Updated 2 pieces.",
      ]);
      expect(outcomes.length).toBe(2);
      expect(forwarded).toEqual({
        configs,
        entry: {
          mainPath: "/repo/pattern.tsx",
          mainExport: undefined,
          repository: ENTRY.repository,
          rootPath: undefined,
          testPaths: undefined,
          dataFilePaths: undefined,
        },
        options: { dangerouslyAllowIncompatibleSchema: undefined },
      });
    });

    it("prints the stop report and lets the failing piece's own error propagate", async () => {
      const lines: string[] = [];
      const stops: string[] = [];
      const failure = new Error("argument links not provable");
      const attempt = setPieceSourceBatchFromCommand(
        {
          apiUrl: API_URL,
          space: SPACE,
          identity: IDENTITY,
          piece: ["p1", "p2", "p3"],
        },
        "/repo/pattern.tsx",
        {
          setPiecePatternBatch: (_configs, _entry, _options, deps) => {
            deps?.onOutcome?.({ piece: "p1" }, 0, 3);
            deps?.onFailure?.({
              piece: "p2",
              index: 1,
              total: 3,
              outcomes: [{ piece: "p1" }],
            });
            return Promise.reject(failure);
          },
          report: (line) => lines.push(line),
          reportError: (line) => stops.push(line),
        },
      );

      await expect(attempt).rejects.toBe(failure);
      expect(lines).toEqual(["Updated source for piece p1 (1/3)"]);
      expect(stops).toEqual([
        "Stopped at piece p2 (2 of 3): 1 updated before the stop; " +
        "1 not attempted.",
      ]);
    });
  });

  describe("checkPieceSourceBatchFromCommand()", () => {
    it("reports every verdict and exits non-zero when any piece cannot be replaced", async () => {
      const lines: string[] = [];
      const errors: string[] = [];
      let exitCode: number | undefined;
      class ExitSentinel extends Error {}
      const attempt = checkPieceSourceBatchFromCommand(
        {
          apiUrl: API_URL,
          space: SPACE,
          identity: IDENTITY,
          piece: ["p1", "p2"],
        },
        "/repo/pattern.tsx",
        {
          checkPiecePatternBatch: () =>
            Promise.resolve([
              { piece: "p1", report: compatibleReport() },
              {
                piece: "p2",
                report: incompatibleReport("result narrowed: label"),
              },
            ]),
          report: (line) => lines.push(line),
          exit: {
            printError: (message) => errors.push(message),
            exit: (code) => {
              exitCode = code;
              throw new ExitSentinel();
            },
          },
        },
      );

      await expect(attempt).rejects.toThrow(ExitSentinel);
      expect(lines).toEqual([
        "/repo/pattern.tsx can replace the source for piece p1",
        "/repo/pattern.tsx cannot replace the source for piece p2:\n" +
        "result narrowed: label",
      ]);
      expect(errors.join("\n")).toContain(
        "cannot replace the source for 1 of 2 pieces",
      );
      expect(exitCode).toBe(1);
    });

    it("returns every verdict without exiting when all pieces can be replaced", async () => {
      const lines: string[] = [];
      const { checks } = await checkPieceSourceBatchFromCommand(
        {
          apiUrl: API_URL,
          space: SPACE,
          identity: IDENTITY,
          piece: ["p1", "p2"],
        },
        "/repo/pattern.tsx",
        {
          checkPiecePatternBatch: () =>
            Promise.resolve([
              { piece: "p1", report: compatibleReport() },
              { piece: "p2", report: compatibleReport() },
            ]),
          report: (line) => lines.push(line),
          exit: {
            printError: () => {},
            exit: () => {
              throw new Error("exited on a fully compatible batch");
            },
          },
        },
      );

      expect(checks.length).toBe(2);
      expect(lines).toEqual([
        "/repo/pattern.tsx can replace the source for piece p1",
        "/repo/pattern.tsx can replace the source for piece p2",
      ]);
    });
  });

  describe("reporting", () => {
    it("formats an updated piece's line with its position in the batch", () => {
      expect(
        formatBatchOutcomeLine({ piece: "p7" }, 6, 106),
      ).toBe("Updated source for piece p7 (7/106)");
    });

    it("totals the stop report from the landed outcomes", () => {
      expect(formatBatchStopReport({
        piece: "p4",
        index: 3,
        total: 6,
        outcomes: [
          { piece: "p1" },
          { piece: "p2" },
          { piece: "p3" },
        ],
      })).toBe(
        "Stopped at piece p4 (4 of 6): 3 updated before the stop; " +
          "2 not attempted.",
      );
    });

    it("totals the updated pieces in the summary", () => {
      expect(formatBatchSummary([
        { piece: "p1" },
        { piece: "p2" },
        { piece: "p3" },
      ])).toBe("Updated 3 pieces.");
    });

    it("points the apply hint at the batch's space", () => {
      const hint = batchApplyNextSteps([configFor("p1"), configFor("p2")]);
      expect(hint).toContain(`${API_URL}/${SPACE}`);
      expect(hint).toContain("piece inspect");
    });

    it("spells the check hint's apply command with every piece flag", () => {
      const hint = batchCheckNextSteps(
        [configFor("p1"), configFor("p2")],
        "/repo/pattern.tsx",
      );
      expect(hint).toContain("--piece p1 --piece p2 /repo/pattern.tsx");
    });
  });

  describe("setSrcBatchAction()", () => {
    it("applies the batch and hints at the batch's space", async () => {
      const hints: string[] = [];
      const reported: string[] = [];
      await setSrcBatchAction(
        {
          apiUrl: API_URL,
          space: SPACE,
          identity: IDENTITY,
          piece: ["p1", "p2"],
        },
        "/repo/pattern.tsx",
        {
          setPiecePatternBatch: () =>
            Promise.resolve([
              { piece: "p1" },
              { piece: "p2" },
            ]),
          report: (line) => reported.push(line),
          hint: (message) => hints.push(message),
        },
      );

      expect(reported).toEqual([
        "Updated 2 pieces.",
      ]);
      expect(hints.length).toBe(1);
      expect(hints[0]).toContain(`${API_URL}/${SPACE}`);
    });

    it("routes `--check` to the aggregate preflight and hints the batch apply command", async () => {
      const hints: string[] = [];
      const reported: string[] = [];
      await setSrcBatchAction(
        {
          apiUrl: API_URL,
          space: SPACE,
          identity: IDENTITY,
          piece: ["p1", "p2"],
          check: true,
        },
        "/repo/pattern.tsx",
        {
          checkPiecePatternBatch: () =>
            Promise.resolve([
              { piece: "p1", report: compatibleReport() },
              { piece: "p2", report: compatibleReport() },
            ]),
          report: (line) => reported.push(line),
          hint: (message) => hints.push(message),
        },
      );

      expect(reported.length).toBe(2);
      expect(hints.length).toBe(1);
      expect(hints[0]).toContain("--piece p1 --piece p2 /repo/pattern.tsx");
    });
  });

  describe("setsrc command dispatch", () => {
    // Each parse-driven case imports a fresh module instance, so
    // `throwErrors()` cannot leak into the singleton command the other tests
    // share. `reset()` first: the chain leaves the builder pointed at its
    // last subcommand, and only the root parents every subcommand's
    // `shouldThrowErrors()` walk.
    async function freshPieceCommand(instance: string) {
      const { piece: command } = await import(
        `../commands/piece.ts?${instance}`
      );
      command.reset().throwErrors();
      return command;
    }

    it("rejects a piece-naming `--url` with repeated `--piece` through the full command parse", async () => {
      const command = await freshPieceCommand("setsrc-batch-url");
      await expect(command.parse([
        "setsrc",
        "--url",
        `${API_URL}/${SPACE}/${"abcdefghijklmnopqrstuvwxyz"}`,
        "--piece",
        "p1",
        "--piece",
        "p2",
        "--identity",
        IDENTITY,
        "/repo/pattern.tsx",
      ])).rejects.toThrow(
        'cannot be provided when the "--url" names a piece',
      );
    });

    it("routes repeated `--piece` with `--check` through the batch preflight", async () => {
      const command = await freshPieceCommand("setsrc-batch-check-url");
      await expect(command.parse([
        "setsrc",
        "--check",
        "--url",
        `${API_URL}/${SPACE}/${"abcdefghijklmnopqrstuvwxyz"}`,
        "--piece",
        "p1",
        "--piece",
        "p2",
        "--identity",
        IDENTITY,
        "/repo/pattern.tsx",
      ])).rejects.toThrow(
        'cannot be provided when the "--url" names a piece',
      );
    });

    it("keeps a single `--piece` on the one-piece path through the full command parse", async () => {
      const command = await freshPieceCommand("setsrc-single");
      // The one-piece refusal for a piece named twice is the single path's
      // own; reaching it proves a lone `--piece` still parses as before.
      await expect(command.parse([
        "setsrc",
        "--url",
        `${API_URL}/${SPACE}/${"abcdefghijklmnopqrstuvwxyz"}`,
        "--piece",
        "p1",
        "--identity",
        IDENTITY,
        "/repo/pattern.tsx",
      ])).rejects.toThrow(
        'cannot be provided when the "--url" names a piece',
      );
    });

    it("keeps a single `--piece --check` on the one-piece preflight through the full command parse", async () => {
      const command = await freshPieceCommand("setsrc-single-check");
      await expect(command.parse([
        "setsrc",
        "--check",
        "--url",
        `${API_URL}/${SPACE}/${"abcdefghijklmnopqrstuvwxyz"}`,
        "--piece",
        "p1",
        "--identity",
        IDENTITY,
        "/repo/pattern.tsx",
      ])).rejects.toThrow(
        'cannot be provided when the "--url" names a piece',
      );
    });
  });
});
