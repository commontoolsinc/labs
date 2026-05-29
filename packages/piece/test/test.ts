import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { PieceManager } from "../src/manager.ts";

describe("noop", () => {
});

describe("PieceManager.get", () => {
  it("syncs a loaded piece before starting it", async () => {
    let pieceSynced = false;
    let startSawSyncedPiece = false;

    const piece = {
      sync: () => {
        pieceSynced = true;
        return Promise.resolve();
      },
      asSchema: () => piece,
    };
    const runtime = {
      userIdentityDID: "did:key:home",
      getSpaceCell: () => ({
        sync: () => Promise.resolve(),
      }),
      getCellFromEntityId: () => piece,
      start: () => {
        startSawSyncedPiece = pieceSynced;
        return Promise.resolve(true);
      },
    };
    const manager = new PieceManager({
      as: {} as never,
      space: "did:key:test-space" as never,
    }, runtime as never);

    await manager.get("piece-id", true, { type: "object" });

    expect(startSawSyncedPiece).toBe(true);
  });
});
