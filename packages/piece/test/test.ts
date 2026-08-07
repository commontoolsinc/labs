import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { PiecesController } from "../src/ops/pieces-controller.ts";
import { taggedHashStringOf } from "@commonfabric/data-model/value-hash";

describe("noop", () => {
});

describe("PiecesController.getPieceCell", () => {
  it("syncs a loaded piece before starting it", async () => {
    let pieceSynced = false;
    let startSawSyncedPiece = false;

    const piece = {
      sync: () => {
        pieceSynced = true;
        return Promise.resolve();
      },
      // A non-wrapper piece resolves to itself; get() canonicalizes the address
      // (value-link slot -> result cell) before syncing + starting.
      resolveAsCell: () => piece,
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
    const pieces = new PiecesController({
      as: {} as never,
      space: "did:key:test-space" as never,
    }, runtime as never);

    await pieces.getPieceCell(taggedHashStringOf("piece-id"), true, {
      type: "object",
    });

    expect(startSawSyncedPiece).toBe(true);
  });
});
