import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { PieceManager } from "../src/manager.ts";

describe("PieceManager.listEntityIds", () => {
  it("waits until the manager is ready and delegates to the space provider", async () => {
    const ready = Promise.withResolvers<void>();
    const listed = ["of:fid1:alpha", "of:fid1:beta"];
    const openedSpaces: string[] = [];
    let listCalls = 0;
    const runtime = {
      userIdentityDID: "did:key:home",
      getSpaceCell: () => ({
        sync: () => Promise.resolve(),
      }),
      storageManager: {
        open: (space: string) => {
          openedSpaces.push(space);
          return {
            listEntityIds: () => {
              listCalls++;
              return Promise.resolve(listed);
            },
          };
        },
      },
    };
    const manager = new PieceManager({
      as: {} as never,
      space: "did:key:test-space" as never,
    }, runtime as never);
    manager.ready = ready.promise;

    const result = manager.listEntityIds();
    await Promise.resolve();
    expect(openedSpaces).toEqual([]);
    expect(listCalls).toBe(0);

    ready.resolve();
    expect(await result).toEqual(listed);
    expect(openedSpaces).toEqual(["did:key:test-space"]);
    expect(listCalls).toBe(1);
  });
});
