import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { CFC_ATOM_TYPE } from "@commonfabric/api/cfc";
import { type Cell, Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import {
  getCellCfcLabel,
  parseCellCfcLabelUpdate,
  setCellCfcLabel,
} from "../lib/piece.ts";
import { cf, stripAnsi } from "./utils.ts";

const signer = await Identity.fromPassphrase("cf-piece-label");
const pieceConfig = {
  apiUrl: "https://example.com",
  identity: "/unused.key",
  space: signer.did(),
  piece: "piece",
};

describe("cf piece CFC labels", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let root: Cell<{ body: string }>;
  let deps: {
    loadPieces: () => Promise<unknown>;
    resolvePieceAddress: (_pieces: unknown, token: string) => Promise<string>;
  };

  beforeEach(async () => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      cfcEnforcementMode: "enforce-explicit",
      cfcDeclaredMonotonicity: "enforce",
    });
    root = runtime.getCell<{ body: string }>(
      signer.did(),
      "cf-piece-label-root",
      {
        type: "object",
        properties: { body: { type: "string" } },
        required: ["body"],
      },
    );
    const tx = runtime.edit();
    root.withTx(tx).set({ body: "hello" });
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit()).error).toBeUndefined();

    const piece = {
      input: { getCell: () => Promise.resolve(root) },
      result: { getCell: () => Promise.resolve(root) },
    };
    const pieces = {
      runtime,
      get: () => Promise.resolve(piece),
      synced: () => Promise.resolve(),
    };
    deps = {
      loadPieces: () => Promise.resolve(pieces),
      resolvePieceAddress: (_pieces, token) => Promise.resolve(token),
    };
  });

  afterEach(async () => {
    await runtime.dispose();
    await storageManager.close();
  });

  it("validates the declared-label JSON shape", () => {
    expect(parseCellCfcLabelUpdate({
      confidentiality: ["team"],
      integrity: [],
      observes: "value",
    })).toEqual({
      confidentiality: ["team"],
      integrity: [],
      observes: "value",
    });
    expect(() => parseCellCfcLabelUpdate(null)).toThrow(
      "must be a JSON object",
    );
    expect(() => parseCellCfcLabelUpdate({ observes: "value" })).toThrow(
      "must include confidentiality or integrity",
    );
    expect(() => parseCellCfcLabelUpdate({ confidentiality: "team" })).toThrow(
      "confidentiality must be a JSON array",
    );
    expect(() => parseCellCfcLabelUpdate({ integrity: [], extra: true }))
      .toThrow("Unknown CFC label field: extra");
    expect(() =>
      parseCellCfcLabelUpdate({ integrity: [], observes: "content" })
    ).toThrow("value, shape, enumerate, or followRef");
  });

  it("sets a declared label and returns its effective view", async () => {
    const updated = await setCellCfcLabel(
      pieceConfig,
      ["body"],
      {
        confidentiality: ["team"],
        integrity: ["reviewed", "authored"],
        observes: "value",
      },
      {},
      deps as never,
    );

    expect(updated).toEqual({
      version: 1,
      entries: [{
        path: [],
        label: {
          confidentiality: ["team"],
          integrity: ["reviewed", "authored"],
        },
        observes: "value",
      }],
    });
    expect(
      await getCellCfcLabel(pieceConfig, ["body"], {}, deps as never),
    ).toEqual(updated);
  });

  it("allows integrity to become less trusted", async () => {
    await setCellCfcLabel(
      pieceConfig,
      ["body"],
      { integrity: ["reviewed", "authored"] },
      {},
      deps as never,
    );
    const updated = await setCellCfcLabel(
      pieceConfig,
      ["body"],
      { integrity: ["reviewed"] },
      {},
      deps as never,
    );

    expect(updated?.entries[0].label.integrity).toEqual(["reviewed"]);

    const cleared = await setCellCfcLabel(
      pieceConfig,
      ["body"],
      { integrity: [] },
      {},
      deps as never,
    );
    expect(cleared).toBeNull();
  });

  it("rejects weaker confidentiality", async () => {
    await setCellCfcLabel(
      pieceConfig,
      ["body"],
      { confidentiality: ["team"] },
      {},
      deps as never,
    );

    await expect(setCellCfcLabel(
      pieceConfig,
      ["body"],
      { confidentiality: [] },
      {},
      deps as never,
    )).rejects.toThrow("confidentiality cannot be weakened");
  });

  it("rejects a conflicting observation class", async () => {
    await setCellCfcLabel(
      pieceConfig,
      ["body"],
      { confidentiality: ["team"], observes: "value" },
      {},
      deps as never,
    );

    await expect(setCellCfcLabel(
      pieceConfig,
      ["body"],
      { confidentiality: ["team"], observes: "shape" },
      {},
      deps as never,
    )).rejects.toThrow("effective label already uses a different");
    expect(
      await getCellCfcLabel(pieceConfig, ["body"], {}, deps as never),
    ).toEqual({
      version: 1,
      entries: [{
        path: [],
        label: { confidentiality: ["team"] },
        observes: "value",
      }],
    });
  });

  it("preserves an observation class when a later update omits it", async () => {
    await setCellCfcLabel(
      pieceConfig,
      ["body"],
      { confidentiality: ["team"], observes: "value" },
      {},
      deps as never,
    );

    const updated = await setCellCfcLabel(
      pieceConfig,
      ["body"],
      { confidentiality: ["team", "legal"] },
      {},
      deps as never,
    );
    expect(updated).toEqual({
      version: 1,
      entries: [{
        path: [],
        label: { confidentiality: ["team", "legal"] },
        observes: "value",
      }],
    });
  });

  it("redacts caveat sources from command-facing label views", async () => {
    const updated = await setCellCfcLabel(
      pieceConfig,
      ["body"],
      {
        confidentiality: [{
          type: CFC_ATOM_TYPE.Caveat,
          kind: "derived-from",
          source: "did:key:private-source",
        }],
      },
      {},
      deps as never,
    );

    expect(updated?.entries[0].label.confidentiality).toEqual([{
      type: CFC_ATOM_TYPE.Caveat,
      kind: "derived-from",
    }]);
  });

  it("returns null for unlabeled values and rejects absent paths", async () => {
    expect(
      await getCellCfcLabel(pieceConfig, ["body"], {}, deps as never),
    ).toBeNull();
    await expect(setCellCfcLabel(
      pieceConfig,
      ["missing"],
      { confidentiality: ["team"] },
      {},
      deps as never,
    )).rejects.toThrow('absent path "missing"');
  });

  it("fails when label metadata cannot be read", async () => {
    const failingCell = {
      pull: () => Promise.resolve(),
      key: () => failingCell,
      getAsNormalizedFullLink: () => ({
        space: signer.did(),
        id: "unreadable-labels",
        path: [],
      }),
      runtime: {
        readTx: () => {
          throw new Error("metadata unavailable");
        },
      },
    };
    let editCalled = false;
    const failingPieces = {
      runtime: {
        edit: () => {
          editCalled = true;
          throw new Error("edit must not start");
        },
      },
      get: () =>
        Promise.resolve({
          input: { getCell: () => Promise.resolve(failingCell) },
          result: { getCell: () => Promise.resolve(failingCell) },
        }),
    };
    const failingDeps = {
      loadPieces: () => Promise.resolve(failingPieces),
      resolvePieceAddress: (_pieces: unknown, token: string) =>
        Promise.resolve(token),
    };

    await expect(getCellCfcLabel(
      pieceConfig,
      [],
      {},
      failingDeps as never,
    )).rejects.toThrow('Could not read CFC labels at "<root>"');
    await expect(setCellCfcLabel(
      pieceConfig,
      [],
      { confidentiality: ["team"] },
      {},
      failingDeps as never,
    )).rejects.toThrow('Could not read CFC labels at "<root>"');
    expect(editCalled).toBe(false);
  });

  it("documents JSON input and output on both commands", async () => {
    const getHelp = await cf("piece get-label --help");
    expect(getHelp.code).toBe(0);
    expect(stripAnsi(getHelp.stdout.join("\n"))).toContain(
      "effective CFC label view",
    );
    expect(getHelp.stdout.join("\n")).toContain("--json");

    const setHelp = await cf("piece set-label --help");
    expect(setHelp.code).toBe(0);
    const text = stripAnsi(setHelp.stdout.join("\n"));
    expect(text).toContain("from JSON on stdin");
    expect(text).toMatch(/Confidentiality\s+can only become stricter/);
    expect(text).toContain("--json");
  });
});
