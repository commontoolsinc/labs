import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { PiecesController } from "../src/ops/pieces-controller.ts";

describe("PiecesController.listEntityIds", () => {
  it("opens the space session without requesting entity identifiers", async () => {
    const ready = Promise.withResolvers<void>();
    const openedSpaces: string[] = [];
    let sessionCalls = 0;
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
            ensureSession: () => {
              sessionCalls++;
              return Promise.resolve();
            },
            listEntityIds: () => {
              listCalls++;
              return Promise.resolve([]);
            },
          };
        },
      },
    };
    const pieces = new PiecesController({
      as: {} as never,
      space: "did:key:test-space" as never,
    }, runtime as never);
    pieces.ready = ready.promise;

    const result = pieces.ensureSpaceSession();
    await Promise.resolve();
    expect(openedSpaces).toEqual([]);
    expect(sessionCalls).toBe(0);

    ready.resolve();
    await result;
    expect(openedSpaces).toEqual(["did:key:test-space"]);
    expect(sessionCalls).toBe(1);
    expect(listCalls).toBe(0);
  });

  it("waits until the pieces is ready and delegates to the space provider", async () => {
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
    const pieces = new PiecesController({
      as: {} as never,
      space: "did:key:test-space" as never,
    }, runtime as never);
    pieces.ready = ready.promise;

    const result = pieces.listEntityIds();
    await Promise.resolve();
    expect(openedSpaces).toEqual([]);
    expect(listCalls).toBe(0);

    ready.resolve();
    expect(await result).toEqual(listed);
    expect(openedSpaces).toEqual(["did:key:test-space"]);
    expect(listCalls).toBe(1);
  });
});
