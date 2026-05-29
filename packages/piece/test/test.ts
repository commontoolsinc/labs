import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { PieceManager } from "../src/manager.ts";

describe("noop", () => {
});

describe("PieceManager.get", () => {
  it("syncs the supplied schema view before starting it", async () => {
    const schema = { type: "object" } as const;
    let rootPieceSynced = false;
    let schemaPieceSynced = false;
    let startSawSyncedSchemaPiece = false;

    const schemaPiece = {
      sync: () => {
        schemaPieceSynced = true;
        return Promise.resolve();
      },
      asSchema: () => schemaPiece,
    };
    const piece = {
      sync: () => {
        rootPieceSynced = true;
        return Promise.resolve();
      },
      asSchema: (requestedSchema: unknown) => {
        expect(requestedSchema).toBe(schema);
        return schemaPiece;
      },
    };
    const runtime = {
      userIdentityDID: "did:key:home",
      getSpaceCell: () => ({
        sync: () => Promise.resolve(),
      }),
      getCellFromEntityId: () => piece,
      start: (startedPiece: unknown) => {
        startSawSyncedSchemaPiece = startedPiece === schemaPiece &&
          schemaPieceSynced;
        return Promise.resolve(true);
      },
    };
    const manager = new PieceManager({
      as: {} as never,
      space: "did:key:test-space" as never,
    }, runtime as never);

    await manager.get("piece-id", true, schema);

    expect(rootPieceSynced).toBe(false);
    expect(startSawSyncedSchemaPiece).toBe(true);
  });
});
