import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { createSession, Identity } from "@commontools/identity";
import { Runtime } from "@commontools/runner";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { createBuilder } from "../../runner/src/builder/factory.ts";
import type { Cell } from "../../runner/src/builder/types.ts";
import { pieceId, PieceManager } from "../src/manager.ts";

const signer = await Identity.fromPassphrase(
  "test default pattern persistence",
);

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
    const { commontools } = createBuilder();
    const { handler, pattern } = commontools;

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
});
