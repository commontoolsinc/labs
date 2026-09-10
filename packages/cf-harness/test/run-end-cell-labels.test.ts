/**
 * The cell-label snapshot a run takes as it ends. The labels are read from
 * the run's space and land beside the run in the same write as its outcome,
 * for a completed run and a failed one alike; a run that names no space or
 * holds no cell takes none, and a snapshot that could not be written is a
 * failure record on the run rather than a silent absence.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { join } from "@std/path";

import {
  FileSystemHarnessArtifactStore,
  readHarnessRunState,
} from "../src/artifacts.ts";
import {
  HARNESS_CELL_LABELS_TYPE,
  type HarnessCellLabelEntry,
  type HarnessCellLabels,
  harnessCellLabelsSummary,
} from "../src/contracts/cell-labels.ts";
import {
  CfHarnessEngine,
  type CreateHarnessEngineOptions,
} from "../src/engine.ts";
import {
  createHarnessHandleTable,
  mintAddressHandle,
} from "../src/handle-table.ts";
import {
  LABELED_CELL_ID,
  LABELED_CELL_LABEL,
  seedSpaceDb,
  SPACE_DB_DID,
} from "./support/space-db.ts";

/** A reference into the labelled cell, of the shape an input cell carries. */
const LABELED_REF = `/${LABELED_CELL_ID}/value/secret`;

/** One label entry, for the cases that only need a cell to carry any. */
const LABELLED_ENTRY: HarnessCellLabelEntry = {
  path: ["value", "secret"],
  origin: "declared",
  confidentiality: [
    { type: "https://cfc.test/atom/email", name: "email" },
  ],
  integrity: [],
};

const withDirectory = async (
  body: (directory: string) => Promise<void>,
): Promise<void> => {
  const directory = await Deno.makeTempDir({
    prefix: "cf-harness-run-end-cell-labels-",
  });
  try {
    await body(directory);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
};

/** The session configuration naming the seeded space; nothing connects. */
const fabricSession = (directory: string) => ({
  apiUrl: "http://fabric.test",
  identityKeyPath: join(directory, "key.pkcs8"),
  space: SPACE_DB_DID,
});

/**
 * An engine over the seeded space whose handle table names the labelled
 * cell, with `options` laid over the rest of its configuration.
 */
const engineHolding = async (
  directory: string,
  runId: string,
  options: Partial<CreateHarnessEngineOptions> = {},
): Promise<CfHarnessEngine> => {
  const engine = new CfHarnessEngine({
    artifactRoot: join(directory, "runs"),
    runId,
    workspaceHostPath: join(directory, "workspace"),
    fabricSession: fabricSession(directory),
    fabricSessionFactory: () =>
      Promise.reject(new Error("no fabric session is opened by these tests")),
    spaceDbPath: seedSpaceDb(directory),
    ...options,
  });
  await engine.recordHandleTable(
    (await mintAddressHandle(createHarnessHandleTable(runId), LABELED_REF))
      .table,
  );
  return engine;
};

const runRootOf = (directory: string, runId: string): string =>
  join(directory, "runs", runId);

const readCellLabels = async (runRoot: string): Promise<HarnessCellLabels> =>
  JSON.parse(
    await Deno.readTextFile(join(runRoot, "cell-labels.json")),
  ) as HarnessCellLabels;

const exists = async (path: string): Promise<boolean> => {
  try {
    await Deno.stat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return false;
    }
    throw error;
  }
};

describe("run-end cell labels", () => {
  describe("completeRun()", () => {
    it("keeps the per-cell records out of the run's own state", () => {
      // A run's state is rewritten whole whenever anything about the run
      // advances, so a record per cell the run touched would cost the
      // snapshot's size at every one of those writes. The state carries the
      // findings, whose size is fixed, and names the file holding the rest.
      const labels: HarnessCellLabels = {
        type: HARNESS_CELL_LABELS_TYPE,
        version: 1,
        generatedAt: "2026-09-10T00:00:00.000Z",
        status: "read",
        space: { configured: "a-space" },
        cells: [
          { entityId: "of:fid1:labelled", entries: [LABELLED_ENTRY] },
          { entityId: "of:fid1:bare", entries: [] },
        ],
      };

      const summary = harnessCellLabelsSummary(labels, "/runs/r/cells.json");

      expect(Object.hasOwn(summary, "cells")).toBe(false);
      expect(summary.cellCount).toBe(2);
      expect(summary.labelledCellCount).toBe(1);
      expect(summary.cellsPath).toBe("/runs/r/cells.json");
      expect(summary.status).toBe("read");
      expect(summary.space).toEqual({ configured: "a-space" });
    });

    it("omits `cellsPath` for a snapshot no store wrote", () => {
      // With no file beside it, the findings are the whole of what the run
      // records — which is what keeps the `read` against `unavailable`
      // distinction alive on a store that persists no snapshot.
      const summary = harnessCellLabelsSummary({
        type: HARNESS_CELL_LABELS_TYPE,
        version: 1,
        generatedAt: "2026-09-10T00:00:00.000Z",
        status: "unavailable",
        unavailableReason: "space-not-found",
        cells: [],
      });

      expect(summary.cellsPath).toBeUndefined();
      expect(summary.status).toBe("unavailable");
      expect(summary.unavailableReason).toBe("space-not-found");
      expect(summary.cellCount).toBe(0);
    });

    it("writes `cell-labels.json` beside the run, read from the space, and records it on the run's outcome", async () => {
      await withDirectory(async (directory) => {
        const runId = "run-completed";
        const engine = await engineHolding(directory, runId);

        await engine.completeRun("assistant_completed");

        const runRoot = runRootOf(directory, runId);
        const state = await readHarnessRunState(
          join(runRoot, "run-state.json"),
        );
        expect(state.status).toBe("completed");
        expect(state.cellLabels?.cellsPath).toBe(
          join(runRoot, "cell-labels.json"),
        );
        expect(state.cellLabels?.status).toBe("read");
        expect(state.failureRecords ?? []).toEqual([]);
        const labels = await readCellLabels(runRoot);
        expect(state.cellLabels).toEqual(
          harnessCellLabelsSummary(labels, join(runRoot, "cell-labels.json")),
        );
        expect(state.cellLabels?.cellCount).toBe(labels.cells.length);
        expect(labels.status).toBe("read");
        expect(labels.space).toEqual({
          configured: SPACE_DB_DID,
          did: SPACE_DB_DID,
          dbPath: join(directory, `${SPACE_DB_DID}.sqlite`),
        });
        expect(labels.cells.map((cell) => cell.ref)).toEqual([LABELED_REF]);
        expect(labels.cells[0].entityId).toBe(LABELED_CELL_ID);
        expect(labels.cells[0].unreadReason).toBeUndefined();
        expect(labels.cells[0].entries).toHaveLength(1);
        expect(labels.cells[0].entries[0].path).toEqual([]);
        expect(labels.cells[0].entries[0].origin).toBe("declared");
        expect(
          labels.cells[0].entries[0].confidentiality.map((atom) => atom.type),
        ).toEqual([...LABELED_CELL_LABEL.confidentiality]);
        expect(
          labels.cells[0].entries[0].integrity.map((atom) => atom.type),
        ).toEqual([...LABELED_CELL_LABEL.integrity]);
      });
    });

    it("records the space as unavailable, not its cells as unlabelled, when the host holds no copy of it", async () => {
      await withDirectory(async (directory) => {
        const runId = "run-no-space-copy";
        const engine = await engineHolding(directory, runId, {
          spaceDbPath: join(directory, "elsewhere.sqlite"),
        });

        await engine.completeRun("assistant_completed");

        const runRoot = runRootOf(directory, runId);
        const state = await readHarnessRunState(
          join(runRoot, "run-state.json"),
        );
        expect(state.status).toBe("completed");
        expect(state.failureRecords ?? []).toEqual([]);
        const labels = await readCellLabels(runRoot);
        expect(labels.status).toBe("unavailable");
        expect(labels.unavailableReason).toBe("space-not-found");
        expect(labels.cells).toEqual([]);
      });
    });

    it("takes no snapshot for a run that names no space", async () => {
      await withDirectory(async (directory) => {
        const runId = "run-no-space";
        const engine = new CfHarnessEngine({
          artifactRoot: join(directory, "runs"),
          runId,
          workspaceHostPath: join(directory, "workspace"),
        });
        await engine.recordHandleTable(
          (await mintAddressHandle(
            createHarnessHandleTable(runId),
            LABELED_REF,
          )).table,
        );

        await engine.completeRun("assistant_completed");

        const runRoot = runRootOf(directory, runId);
        const state = await readHarnessRunState(
          join(runRoot, "run-state.json"),
        );
        expect(state.status).toBe("completed");
        expect(state.cellLabels).toBeUndefined();
        expect(state.failureRecords ?? []).toEqual([]);
        expect(await exists(join(runRoot, "cell-labels.json"))).toBe(false);
      });
    });

    it("takes no snapshot for a run that holds no cell", async () => {
      await withDirectory(async (directory) => {
        const runId = "run-no-cells";
        const engine = new CfHarnessEngine({
          artifactRoot: join(directory, "runs"),
          runId,
          workspaceHostPath: join(directory, "workspace"),
          fabricSession: fabricSession(directory),
          fabricSessionFactory: () =>
            Promise.reject(
              new Error("no fabric session is opened by these tests"),
            ),
          spaceDbPath: seedSpaceDb(directory),
        });

        await engine.completeRun("assistant_completed");

        const runRoot = runRootOf(directory, runId);
        const state = await readHarnessRunState(
          join(runRoot, "run-state.json"),
        );
        expect(state.status).toBe("completed");
        expect(state.cellLabels).toBeUndefined();
        expect(state.failureRecords ?? []).toEqual([]);
        expect(await exists(join(runRoot, "cell-labels.json"))).toBe(false);
      });
    });

    it("records a failure on the run, and still ends it, when the snapshot cannot be written", async () => {
      await withDirectory(async (directory) => {
        const runId = "run-snapshot-unwritable";
        const artifactStore = new FileSystemHarnessArtifactStore({
          artifactRoot: join(directory, "runs"),
          runId,
        });
        artifactStore.persistCellLabels = () =>
          Promise.reject(new Error("the disk is full"));
        const engine = await engineHolding(directory, runId, {
          artifactStore,
        });

        await engine.completeRun("assistant_completed");

        const runRoot = runRootOf(directory, runId);
        const state = await readHarnessRunState(
          join(runRoot, "run-state.json"),
        );
        expect(state.status).toBe("completed");
        expect(state.terminalReason).toBe("assistant_completed");
        expect(state.cellLabels).toBeUndefined();
        expect(state.failureRecords).toHaveLength(1);
        expect(state.failureRecords?.[0]).toMatchObject({
          kind: "harness_error",
          source: "cell_labels",
          detail: "cell label snapshot failed: the disk is full",
        });
        expect(await exists(join(runRoot, "cell-labels.json"))).toBe(false);
      });
    });
  });

  describe("failRun()", () => {
    it("writes `cell-labels.json` beside a failed run as it does beside a completed one", async () => {
      await withDirectory(async (directory) => {
        const runId = "run-failed";
        const engine = await engineHolding(directory, runId);

        await engine.failRun("max_model_turns", new Error("out of turns"));

        const runRoot = runRootOf(directory, runId);
        const state = await readHarnessRunState(
          join(runRoot, "run-state.json"),
        );
        expect(state.status).toBe("failed");
        expect(state.terminalReason).toBe("max_model_turns");
        expect(state.primaryFailure?.detail).toContain("out of turns");
        expect(state.cellLabels?.cellsPath).toBe(
          join(runRoot, "cell-labels.json"),
        );
        expect(state.cellLabels?.status).toBe("read");
        const labels = await readCellLabels(runRoot);
        expect(labels.status).toBe("read");
        expect(labels.cells.map((cell) => cell.entityId)).toEqual([
          LABELED_CELL_ID,
        ]);
      });
    });
  });
});
