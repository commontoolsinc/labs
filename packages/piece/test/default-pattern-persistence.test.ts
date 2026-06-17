import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { createSession, Identity } from "@commonfabric/identity";
import { entityIdFrom, Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import type { RuntimeProgram } from "../../runner/src/harness/types.ts";
import { createBuilder } from "../../runner/src/builder/factory.ts";
import type { Cell } from "../../runner/src/builder/types.ts";
import { pieceId, PieceManager } from "../src/manager.ts";
import { PiecesController } from "../src/ops/pieces-controller.ts";

const signer = await Identity.fromPassphrase(
  "test default pattern persistence",
);

const defaultPatternProgram: RuntimeProgram = {
  main: "/main.tsx",
  files: [
    {
      name: "/main.tsx",
      contents: [
        "/// <cf-disable-transform />",
        "import { handler, pattern } from 'commonfabric';",
        "const addPiece = handler<{ piece: unknown }, { allPieces: unknown[] }>(",
        "  ({ piece }, { allPieces }) => {",
        "    allPieces.push(piece);",
        "  },",
        "  { proxy: true },",
        ");",
        "export default pattern<{ allPieces: unknown[] }>(({ allPieces }) => ({",
        "  allPieces,",
        "  addPiece: addPiece({ allPieces }),",
        "}));",
      ].join("\n"),
    },
  ],
};

const persistedPieceProgram: RuntimeProgram = {
  main: "/main.tsx",
  files: [
    {
      name: "/main.tsx",
      contents: [
        "import { pattern } from 'commonfabric';",
        "export default pattern<{ value: number }>(({ value }) => ({ value }));",
      ].join("\n"),
    },
  ],
};

async function createDefaultPatternPieceWithResult(manager: PieceManager) {
  const { commonfabric } = createBuilder();
  const { handler, pattern } = commonfabric;

  const addPiece = handler<
    { piece: Cell<unknown> },
    { allPieces: Cell<unknown>[] }
  >(
    ({ piece }, { allPieces }) => {
      allPieces.push(piece);
    },
    { proxy: true },
  );
  const defaultPattern = pattern<{ allPieces: Cell<unknown>[] }>(
    ({ allPieces }) => ({
      allPieces,
      addPiece: addPiece({ allPieces }),
    }),
  );

  const defaultPatternPiece = await manager.runPersistent(
    defaultPattern,
    { allPieces: [] },
    "default-pattern-persistence",
  );
  await manager.linkDefaultPattern(defaultPatternPiece);
  await manager.runtime.idle();
  await manager.synced();

  const persistedPattern = pattern<{ value: number }>(({ value }) => ({
    value,
    nested: { value },
  }));
  const persistedPiece = await manager.runPersistent(
    persistedPattern,
    { value: 42 },
    "persisted-piece",
  );
  await manager.add([persistedPiece]);
  await manager.runtime.idle();
  await manager.synced();

  return persistedPiece;
}

describe("PieceManager default pattern persistence", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let manager: PieceManager;

  beforeEach(async () => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });

    const session = await createSession({
      identity: signer,
      spaceName: "default-pattern-persistence-" + crypto.randomUUID(),
    });
    manager = new PieceManager(session, runtime);
    await manager.synced();
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("reads persisted allPieces without restarting the default pattern", async () => {
    const { commonfabric } = createBuilder();
    const { handler, pattern } = commonfabric;

    const addPiece = handler<
      { piece: Cell<unknown> },
      { allPieces: Cell<unknown>[] }
    >(
      ({ piece }, { allPieces }) => {
        allPieces.push(piece);
      },
      { proxy: true },
    );
    const defaultPattern = pattern<{ allPieces: Cell<unknown>[] }>(
      ({ allPieces }) => ({
        allPieces,
        addPiece: addPiece({ allPieces }),
      }),
    );

    const defaultPatternPiece = await manager.runPersistent(
      defaultPattern,
      { allPieces: [] },
      "default-pattern-persistence",
    );
    await manager.linkDefaultPattern(defaultPatternPiece);
    await manager.runtime.idle();
    await manager.synced();

    const persistedPattern = pattern<{ value: number }>(({ value }) => ({
      value,
    }));
    const persistedPiece = await manager.runPersistent(
      persistedPattern,
      { value: 1 },
      "persisted-piece",
    );
    await manager.add([persistedPiece]);
    await manager.stopPiece(defaultPatternPiece);

    const piecesCell = await manager.getPieces();
    const ids = piecesCell.get().map((piece) => pieceId(piece)).filter(Boolean);

    expect(ids).toContain(pieceId(persistedPiece));
  });

  it("adds a persisted piece from a fresh runtime", async () => {
    const compiledDefaultPattern = await runtime.patternManager.compilePattern(
      defaultPatternProgram,
      { space: manager.getSpace() },
    );
    const defaultPatternPiece = await manager.runPersistent(
      compiledDefaultPattern,
      { allPieces: [] },
      "default-pattern-persistence-fresh",
    );
    await manager.linkDefaultPattern(defaultPatternPiece);
    await manager.runtime.idle();
    await manager.synced();

    // Compile INTO the space so the content-addressed source + compiled docs
    // persist — a fresh runtime recovers the pattern by its `{ identity, symbol }`
    // pointer (there is no longer a meta cell holding the program).
    const compiledPiecePattern = await runtime.patternManager.compilePattern(
      persistedPieceProgram,
      { space: manager.getSpace() },
    );
    const persistedPiece = await manager.runPersistent(
      compiledPiecePattern,
      { value: 2 },
      "persisted-piece-fresh",
    );
    await manager.runtime.idle();
    await manager.synced();

    const session = await createSession({
      identity: signer,
      spaceName: manager.getSpaceName()!,
    });
    const freshRuntime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    const freshManager = new PieceManager(session, freshRuntime);

    try {
      await freshManager.synced();
      const freshPiece = freshRuntime.getCellFromEntityId(
        freshManager.getSpace(),
        entityIdFrom(pieceId(persistedPiece)!),
      );

      await freshManager.add([freshPiece]);
      await freshManager.stopPiece(defaultPatternPiece);

      const piecesCell = await freshManager.getPieces();
      const ids = piecesCell.get().map((piece) => pieceId(piece)).filter(
        Boolean,
      );
      const pieces = new PiecesController(freshManager);
      const listedPiece = (await pieces.getAllPieces()).find((piece) =>
        piece.id === pieceId(persistedPiece)
      );
      const directPiece = await pieces.get(pieceId(persistedPiece)!, false);

      expect(ids.filter((id) => id === pieceId(persistedPiece))).toHaveLength(
        1,
      );
      expect(listedPiece).toBeDefined();
      expect(await listedPiece!.result.get()).toEqual(
        await directPiece.result.get(),
      );
    } finally {
      await freshRuntime.dispose();
    }
  });

  it("getAllPieces controllers expose the same result root as direct cold lookup", async () => {
    const persistedPiece = await createDefaultPatternPieceWithResult(manager);
    const id = pieceId(persistedPiece)!;
    const pieces = new PiecesController(manager);

    const listedPiece = (await pieces.getAllPieces()).find((piece) =>
      piece.id === id
    );
    expect(listedPiece).toBeDefined();

    const directPiece = await pieces.get(id, false);

    expect(await listedPiece!.result.get()).toEqual(
      await directPiece.result.get(),
    );
  });

  it("getAllPieces controllers resolve result paths like direct cold lookup", async () => {
    const persistedPiece = await createDefaultPatternPieceWithResult(manager);
    const id = pieceId(persistedPiece)!;
    const pieces = new PiecesController(manager);

    const listedPiece = (await pieces.getAllPieces()).find((piece) =>
      piece.id === id
    );
    expect(listedPiece).toBeDefined();

    const directPiece = await pieces.get(id, false);

    expect(await listedPiece!.result.get(["value"])).toEqual(
      await directPiece.result.get(["value"]),
    );
    expect(await listedPiece!.result.get(["nested", "value"])).toEqual(
      await directPiece.result.get(["nested", "value"]),
    );
  });
});
