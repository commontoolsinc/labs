import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import type { PieceRootListOptions } from "@commonfabric/runner";
import { PieceManager } from "../src/manager.ts";

const makeManager = (
  listPieceRootPage: (options: PieceRootListOptions) => Promise<unknown>,
) => {
  const runtime = {
    userIdentityDID: "did:key:home",
    getSpaceCell: () => ({
      sync: () => Promise.resolve(),
    }),
    storageManager: {
      open: () => ({ listPieceRootPage }),
    },
  };
  return new PieceManager(
    {
      as: {} as never,
      space: "did:key:test-space" as never,
    },
    runtime as never,
    { deferSpaceCellSync: true },
  );
};

describe("PieceManager.listPieceRoots", () => {
  it("forwards a single indexed page request", async () => {
    const options = {
      limit: 17,
      registeredOnly: true,
    };
    const page = {
      serverSeq: 3,
      pieces: [],
    };
    let received: PieceRootListOptions | undefined;
    const manager = makeManager((request) => {
      received = request;
      return Promise.resolve(page);
    });

    expect(await manager.listPieceRootPage(options)).toEqual(page);
    expect(received).toEqual(options);
  });

  it("collects one snapshot across indexed pages", async () => {
    const requests: PieceRootListOptions[] = [];
    const cursor = {
      id: "piece-a",
      orderKey: "cursor-a",
      scope: "space" as const,
      registered: true,
      registryPosition: 0,
    };
    const pages = [{
      serverSeq: 4,
      pieces: [{
        id: "piece-a",
        scope: "space" as const,
        registered: true,
      }],
      nextAfter: cursor,
    }, {
      serverSeq: 4,
      pieces: [{
        id: "piece-b",
        scope: "user" as const,
        registered: false,
      }],
    }];
    let index = 0;
    const manager = makeManager((options) => {
      requests.push(options);
      return Promise.resolve(pages[index++]);
    });

    expect(await manager.listPieceRoots({ registeredOnly: true })).toEqual([
      pages[0].pieces[0],
      pages[1].pieces[0],
    ]);
    expect(requests).toEqual([{
      registeredOnly: true,
    }, {
      registeredOnly: true,
      after: cursor,
      expectedServerSeq: 4,
    }]);
  });

  it("rejects a continuation whose cursor does not advance", async () => {
    const cursor = {
      id: "piece-a",
      orderKey: "cursor-a",
      scope: "space" as const,
      registered: false,
    };
    const manager = makeManager(() =>
      Promise.resolve({
        serverSeq: 5,
        pieces: [],
        nextAfter: cursor,
      })
    );

    await expect(manager.listPieceRoots()).rejects.toThrow(
      "piece root page did not advance",
    );
  });

  it("rejects a continuation from a different snapshot", async () => {
    const cursor = {
      id: "piece-a",
      orderKey: "cursor-a",
      scope: "space" as const,
      registered: false,
    };
    let index = 0;
    const manager = makeManager(() =>
      Promise.resolve(
        index++ === 0
          ? {
            serverSeq: 6,
            pieces: [],
            nextAfter: cursor,
          }
          : {
            serverSeq: 7,
            pieces: [],
          },
      )
    );

    await expect(manager.listPieceRoots()).rejects.toThrow(
      "piece root snapshot changed from server sequence 6 to 7",
    );
  });
});
