import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { createSession, Identity } from "@commonfabric/identity";
import { Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { PiecesController } from "@commonfabric/piece/ops";
import type { RuntimeProgram } from "@commonfabric/runner";
import type { RepairReport } from "@commonfabric/piece/ops";
import { decode } from "@commonfabric/utils/encoding";

import { type RepairRunRequest, runRepair } from "../lib/bulk.ts";
import { piece, repairFromCommand, setQuietMode } from "../commands/piece.ts";

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

const signer = await Identity.fromPassphrase("cli bulk repair");

const OPTIONS = {
  apiUrl: "http://localhost:8000",
  identity: "/tmp/test-identity.pem",
  space: "home",
  piece: "board",
  quiet: true,
  fixer: "fix-seeds.ts",
};

const REPORT: RepairReport = {
  rows: [{
    piece: "fid1:aaa",
    phase: "members",
    verdict: "would-change",
    documentHash: "9f2c",
    changes: [{ path: "/seed", kind: "changed", before: "a", after: "A" }],
  }],
  plan: {
    header: {
      kind: "piece-plan",
      v: 1,
      space: "did:key:test",
      takenAt: "2026-08-25T00:00:00.000Z",
      selector: "collection",
      enumerated: { collection: 1, registry: 0, registeredOutside: 0 },
    },
    rows: [{
      piece: "fid1:aaa",
      phase: "members",
      expect: {
        patternIdentity: "idA",
        symbol: "default",
        retained: true,
        documentHash: "9f2c",
      },
      op: { kind: "repair", fixer: "fix-seeds.ts" },
    }],
  },
  applied: 0,
  complete: true,
};

describe("piece-repair", () => {
  // The fixtures pass `quiet`, and the action applies it globally.
  afterEach(() => setQuietMode(false));

  describe("repairFromCommand()", () => {
    it("prints the emitted plan to stdout and the verdict tally as a hint", async () => {
      const hints: string[] = [];
      let request: RepairRunRequest | undefined;
      const out = await captureStdout(() =>
        repairFromCommand({ ...OPTIONS, path: "topics" }, {
          runRepair: (_config, req) => {
            request = req;
            return Promise.resolve(REPORT);
          },
          printHint: (message) => {
            hints.push(message);
          },
        })
      );
      expect(out).toContain('"kind":"piece-plan"');
      expect(out).toContain('"kind":"repair"');
      expect(request?.selector).toEqual({
        kind: "collection",
        holder: "board",
        path: ["topics"],
      });
      expect(request?.fixerName).toBe("fix-seeds.ts");
      expect(request?.fixerPath.endsWith("/fix-seeds.ts")).toBe(true);
      expect(request?.apply).toBeUndefined();
      expect(hints).toEqual(["would-change: 1"]);
    });

    it("passes the plan path and the apply flag through", async () => {
      let request: RepairRunRequest | undefined;
      await captureStdout(() =>
        repairFromCommand(
          { ...OPTIONS, path: "topics", plan: "plan.jsonl", apply: true },
          {
            runRepair: (_config, req) => {
              request = req;
              return Promise.resolve(REPORT);
            },
            printHint: () => {},
          },
        )
      );
      expect(request?.planPath?.endsWith("/plan.jsonl")).toBe(true);
      expect(request?.apply).toBe(true);
    });

    it("writes the plan to --out and exits nonzero on an incomplete run", async () => {
      let written: { path: string; text: string } | undefined;
      const hints: string[] = [];
      const incomplete: RepairReport = {
        ...REPORT,
        rows: [{
          piece: "fid1:aaa",
          phase: "members",
          verdict: "refused",
          documentHash: "9f2c",
          problem: "the fixer threw",
        }],
        complete: false,
      };
      await expect(
        captureStdout(() =>
          repairFromCommand({ ...OPTIONS, path: "topics", out: "plan.jsonl" }, {
            runRepair: () => Promise.resolve(incomplete),
            writeTextFile: (path, text) => {
              written = { path: String(path), text: String(text) };
              return Promise.resolve();
            },
            printHint: (message) => {
              hints.push(message);
            },
            printError: () => {},
            exit: () => {
              throw new ExitSentinel();
            },
          })
        ),
      ).rejects.toThrow(ExitSentinel);
      expect(written?.path).toBe("plan.jsonl");
      expect(written?.text).toContain('"piece-plan"');
      expect(hints).toContain("refused: fid1:aaa the fixer threw");
    });

    it("routes cf piece repair to repairFromCommand", () => {
      const registered = piece.getCommand("repair") as unknown as {
        actionHandler?: unknown;
      };
      expect(registered?.actionHandler).toBe(repairFromCommand);
    });
  });

  describe("runRepair()", () => {
    let storageManager: ReturnType<typeof StorageManager.emulate>;
    let runtime: Runtime;
    let pieces: PiecesController;

    beforeEach(async () => {
      storageManager = StorageManager.emulate({ as: signer });
      runtime = new Runtime({
        apiUrl: new URL("http://toolshed.test"),
        storageManager,
      });
      pieces = new PiecesController(
        await createSession({
          identity: signer,
          spaceName: `cli-bulk-repair-${crypto.randomUUID()}`,
        }),
        runtime,
      );
      await pieces.synced();
    });

    afterEach(async () => {
      await runtime?.dispose();
      await storageManager?.close();
    });

    /** The smallest repairable member; `seed` is what the fixer changes. */
    function memberProgram(): RuntimeProgram {
      return {
        main: "/main.tsx",
        files: [{
          name: "/main.tsx",
          contents: [
            "import { NAME, pattern } from 'commonfabric';",
            "export default pattern<{ seed?: string }>(({ seed }) => ({",
            "  [NAME]: 'Member',",
            "  seed,",
            "}));",
            "",
          ].join("\n"),
        }],
      };
    }

    const upperSeed = {
      default: (document: Readonly<Record<string, unknown>>) => ({
        ...document,
        ...(typeof document.seed === "string"
          ? { seed: document.seed.toUpperCase() }
          : {}),
      }),
    };

    it("imports the fixer, runs dry, and applies from the emitted plan", async () => {
      const member = await pieces.create(memberProgram(), {
        input: { seed: "alpha" },
      });
      const base = {
        selector: { kind: "list" as const, pieces: [member.id] },
        fixerPath: "/repairs/fix-seeds.ts",
        fixerName: "fix-seeds.ts",
      };
      const deps = {
        loadPieces: () => Promise.resolve(pieces),
        resolvePieceAddress: (_pieces: unknown, token: string) =>
          Promise.resolve(token),
        importModule: (path: string) => {
          expect(path).toBe("/repairs/fix-seeds.ts");
          return Promise.resolve(upperSeed);
        },
      };

      const dry = await runRepair({} as never, base, deps as never);
      expect(dry.rows[0].verdict).toBe("would-change");
      expect(dry.applied).toBe(0);
      expect(dry.plan.rows[0].op).toEqual({
        kind: "repair",
        fixer: "fix-seeds.ts",
      });

      // The emitted plan drives the apply, read back through the codec.
      const applied = await runRepair({} as never, {
        ...base,
        planPath: "/plans/repair.jsonl",
        apply: true,
      }, {
        ...deps,
        readTextFile: (path: string) => {
          expect(path).toBe("/plans/repair.jsonl");
          return Promise.resolve(
            [
              JSON.stringify(dry.plan.header),
              ...dry.plan.rows.map((row) => JSON.stringify(row)),
            ].join("\n"),
          );
        },
      } as never);
      expect(applied.rows[0].verdict).toBe("repaired");
      expect(applied.complete).toBe(true);

      const cell = await member.input.getCell();
      await cell.pull();
      expect(
        (cell.getRaw({ lastNode: "value" }) as { seed?: unknown }).seed,
      ).toBe("ALPHA");
    });

    it("refuses a fixer module that does not default-export a function", async () => {
      await expect(
        runRepair({} as never, {
          selector: { kind: "list", pieces: ["fid1:x"] },
          fixerPath: "/repairs/empty.ts",
          fixerName: "empty.ts",
        }, {
          loadPieces: () => {
            throw new Error("must not load");
          },
          importModule: () => Promise.resolve({}),
        } as never),
      ).rejects.toThrow("must default-export the fixer function");
    });
  });
});
