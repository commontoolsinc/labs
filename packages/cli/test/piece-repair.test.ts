/**
 * `cf piece repair`'s command action and its `runRepair` seam: flag intake
 * and passthrough, output in both modes, the exit discipline, and the run
 * end to end against a real controller over emulated storage — the fixer
 * module injected, so no disk import runs in a unit test.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { FabricHash } from "@commonfabric/data-model/fabric-primitives";
import { createSession, Identity } from "@commonfabric/identity";
import { PiecesController, type RepairReport } from "@commonfabric/piece/ops";
import { Runtime, type RuntimeProgram } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { decode } from "@commonfabric/utils/encoding";

import {
  programEntryIdentity,
  resolveLocalSourceProgram,
} from "@commonfabric/piece/ops/bulk-local";

import { type RepairRunRequest, runRepair, zeroRowFixer } from "../lib/bulk.ts";
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
      op: { kind: "repair", fixer: "fix-seeds.ts", fixerIdentity: "impl-v1" },
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
      // The dry run's product is the exact diff, so it renders beside the
      // tally.
      expect(hints).toEqual([
        "would-change: 1",
        '~ fid1:aaa /seed "a" -> "A"',
      ]);
    });

    it("renders the dry diff through the canonical debug stringifier", async () => {
      const hints: string[] = [];
      const fabric: RepairReport = {
        ...REPORT,
        rows: [{
          piece: "fid1:aaa",
          verdict: "would-change",
          documentHash: "9f2c",
          changes: [
            { path: "/gone", kind: "removed", before: 1 },
            {
              path: "/pin",
              kind: "added",
              after: FabricHash.fromString("fid1:" + "A".repeat(43)),
            },
          ],
        }],
      };
      await captureStdout(() =>
        repairFromCommand({ ...OPTIONS, path: "topics" }, {
          runRepair: () => Promise.resolve(fabric),
          printHint: (message) => {
            hints.push(message);
          },
        })
      );
      expect(hints).toContain("- fid1:aaa /gone 1");
      const added = hints.find((line) => line.startsWith("+ fid1:aaa /pin"));
      // A Fabric special value renders in the canonical debug form — its
      // kind named, never an empty shell; the value-exact rendering is the
      // --json encoding's job.
      expect(added).toBeDefined();
      expect(added).toContain("/Hash(");
    });

    it("emits --json in the canonical FabricValue encoding", async () => {
      const a = FabricHash.fromString("fid1:" + "A".repeat(43));
      const b = FabricHash.fromString("fid1:" + "B".repeat(42) + "A");
      const fabric: RepairReport = {
        ...REPORT,
        rows: [{
          piece: "fid1:aaa",
          verdict: "would-change",
          documentHash: "9f2c",
          changes: [{ path: "/pin", kind: "changed", before: a, after: b }],
        }],
      };
      const out = await captureStdout(() =>
        repairFromCommand({ ...OPTIONS, path: "topics", json: true }, {
          runRepair: () => Promise.resolve(fabric),
          printHint: () => {},
        })
      );
      expect(out.startsWith("fvj1:")).toBe(true);
      // Two distinct hashes stay two distinct hashes, not two empty shells.
      expect(out).toContain("A".repeat(43));
      expect(out).toContain("B".repeat(42));
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
            exit: (code) => {
              expect(code).toBe(1);
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
      // One snapshot serves identity and execution alike; the stubs stand
      // in for both halves of that single resolution.
      const snapshot = {
        main: "/fix-seeds.ts",
        files: [{ name: "/fix-seeds.ts", contents: "// stub" }],
      };
      const deps = {
        loadPieces: () => Promise.resolve(pieces),
        resolvePieceAddress: (_pieces: unknown, token: string) =>
          Promise.resolve(token),
        resolveFixerProgram: (path: string) => {
          expect(path).toBe("/repairs/fix-seeds.ts");
          return Promise.resolve(snapshot);
        },
        programIdentity: (program: unknown) => {
          expect(program).toBe(snapshot);
          return Promise.resolve("impl-v1");
        },
        importProgram: (program: unknown) => {
          expect(program).toBe(snapshot);
          return Promise.resolve(upperSeed);
        },
      };

      const dry = await runRepair({} as never, base, deps as never);
      expect(dry.rows[0].verdict).toBe("would-change");
      expect(dry.applied).toBe(0);
      expect(dry.plan.rows[0].op).toEqual({
        kind: "repair",
        fixer: "fix-seeds.ts",
        fixerIdentity: "impl-v1",
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

      // An edited fixer resolves to a different closure identity, and the
      // reviewed plan refuses before the module is even imported — a
      // dynamic import runs top-level code nobody reviewed.
      let imported = false;
      await expect(
        runRepair({} as never, {
          ...base,
          planPath: "/plans/repair.jsonl",
          apply: true,
        }, {
          ...deps,
          importProgram: () => {
            imported = true;
            return Promise.resolve(upperSeed);
          },
          programIdentity: () => Promise.resolve("impl-v2"),
          readTextFile: () =>
            Promise.resolve(
              [
                JSON.stringify(dry.plan.header),
                ...dry.plan.rows.map((row) => JSON.stringify(row)),
              ].join("\n"),
            ),
        } as never),
      ).rejects.toThrow("different fixer implementation");
      expect(imported).toBe(false);

      // A plan that cannot run any fixer — an op-less row — refuses before
      // the import too, for the same reason.
      let importedOpless = false;
      await expect(
        runRepair({} as never, {
          ...base,
          planPath: "/plans/repair.jsonl",
          apply: true,
        }, {
          ...deps,
          importProgram: () => {
            importedOpless = true;
            return Promise.resolve(upperSeed);
          },
          readTextFile: () =>
            Promise.resolve(
              [
                JSON.stringify(dry.plan.header),
                ...dry.plan.rows.map((row) => {
                  const { op: _, ...survey } = row;
                  return JSON.stringify(survey);
                }),
              ].join("\n"),
            ),
        } as never),
      ).rejects.toThrow("no repair operation");
      expect(importedOpless).toBe(false);

      const cell = await member.input.getCell();
      await cell.pull();
      expect(
        (cell.getRaw({ lastNode: "value" }) as { seed?: unknown }).seed,
      ).toBe("ALPHA");
    });

    it("hashes and executes one snapshot, whatever the disk does after", async () => {
      const member = await pieces.create(memberProgram(), {
        input: { seed: "alpha" },
      });
      const dir = await Deno.makeTempDir({ prefix: "cli-repair-fixer" });
      try {
        const fixerPath = `${dir}/fix-seeds.ts`;
        await Deno.writeTextFile(
          fixerPath,
          [
            'import { transform } from "./helper.ts";',
            "export default (document: Readonly<Record<string, unknown>>) => ({",
            "  ...document,",
            '  ...(typeof document.seed === "string"',
            "    ? { seed: transform(document.seed) }",
            "    : {}),",
            "});",
            "",
          ].join("\n"),
        );
        await Deno.writeTextFile(
          `${dir}/helper.ts`,
          "export const transform = (text: string) => text.toUpperCase();\n",
        );
        // The resolution is the test's hook: it hands the run the REAL
        // resolved snapshot, then rewrites both files on disk. The default
        // identity and import run on the snapshot, so the recorded pin and
        // the executed behavior must both be the originals.
        const snapshot = await resolveLocalSourceProgram(pieces.runtime, {
          main: fixerPath,
        });
        const expectedIdentity = await programEntryIdentity(snapshot);
        const dry = await runRepair({} as never, {
          selector: { kind: "list", pieces: [member.id] },
          fixerPath,
          fixerName: "fix-seeds.ts",
        }, {
          loadPieces: () => Promise.resolve(pieces),
          resolvePieceAddress: (_pieces: unknown, token: string) =>
            Promise.resolve(token),
          resolveFixerProgram: async () => {
            await Deno.writeTextFile(
              `${dir}/helper.ts`,
              "export const transform = (text: string) => " +
                "text.toLowerCase();\n",
            );
            await Deno.writeTextFile(
              fixerPath,
              "export default () => ({ hijacked: true });\n",
            );
            return snapshot;
          },
        } as never);
        expect(dry.rows[0].verdict).toBe("would-change");
        expect(dry.rows[0].changes).toEqual([
          { path: "/seed", kind: "changed", before: "alpha", after: "ALPHA" },
        ]);
        const op = dry.plan.rows[0].op;
        if (op?.kind !== "repair") throw new Error("expected a repair op");
        expect(op.fixerIdentity).toBe(expectedIdentity);
      } finally {
        await Deno.remove(dir, { recursive: true });
      }
    });

    it("never imports the fixer for a zero-row plan", async () => {
      // A holder with an empty collection: the dry run's plan has no
      // member rows, which is a valid artifact — and one that pins
      // nothing, so nothing may run under it, the import included.
      const holder = await pieces.create({
        main: "/main.tsx",
        files: [{
          name: "/main.tsx",
          contents: [
            "import { NAME, pattern } from 'commonfabric';",
            "export default pattern<{ members?: unknown[] }>(",
            "  ({ members }) => ({ [NAME]: 'Holder', members }),",
            ");",
            "",
          ].join("\n"),
        }],
      }, { input: { members: [] } });
      // A real (if trivial) fixer file, so the default snapshot
      // resolution and identity run for real; only the import is a spy.
      const dir = await Deno.makeTempDir({ prefix: "cli-repair-zero" });
      const fixerPath = `${dir}/fix.ts`;
      await Deno.writeTextFile(
        fixerPath,
        "export default (d: Readonly<Record<string, unknown>>) => ({ ...d });\n",
      );
      let imports = 0;
      const deps = {
        loadPieces: () => Promise.resolve(pieces),
        resolvePieceAddress: (_pieces: unknown, token: string) =>
          Promise.resolve(token),
        importProgram: () => {
          imports += 1;
          return Promise.resolve(upperSeed);
        },
      };
      const base = {
        selector: {
          kind: "collection" as const,
          holder: holder.id,
          path: ["members"],
        },
        fixerPath,
        fixerName: "fix.ts",
      };
      const dry = await runRepair({} as never, base, deps as never);
      expect(dry.plan.rows).toEqual([]);
      expect(imports).toBe(1);

      const applied = await runRepair({} as never, {
        ...base,
        planPath: "/plans/empty.jsonl",
        apply: true,
      }, {
        ...deps,
        readTextFile: () => Promise.resolve(JSON.stringify(dry.plan.header)),
      } as never);
      expect(applied.rows).toEqual([]);
      expect(applied.complete).toBe(true);
      expect(applied.applied).toBe(0);
      // The dry run imported once; the zero-row apply imported nothing.
      expect(imports).toBe(1);
      await Deno.remove(dir, { recursive: true });
      // The stub a zero-row run carries refuses if anything ever calls it.
      expect(() => zeroRowFixer()).toThrow("runs no fixer");
    });

    it("refuses a fixer module that does not default-export a function", async () => {
      const member = await pieces.create(memberProgram(), {
        input: { seed: "alpha" },
      });
      await expect(
        runRepair({} as never, {
          selector: { kind: "list", pieces: [member.id] },
          fixerPath: "/repairs/empty.ts",
          fixerName: "empty.ts",
        }, {
          loadPieces: () => Promise.resolve(pieces),
          resolvePieceAddress: (_pieces: unknown, token: string) =>
            Promise.resolve(token),
          resolveFixerProgram: () =>
            Promise.resolve({
              main: "/empty.ts",
              files: [{ name: "/empty.ts", contents: "" }],
            }),
          programIdentity: () => Promise.resolve("impl-v1"),
          importProgram: () => Promise.resolve({}),
        } as never),
      ).rejects.toThrow("must default-export the fixer function");
    });
  });
});
