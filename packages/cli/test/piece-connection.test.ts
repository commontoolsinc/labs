/**
 * Unit tests for the `lib/piece.ts` functions that take the connection as a
 * parameter. The piece behind the connection is a double throughout, so what
 * each function does with one — the value it writes, the piece it removes,
 * the link it makes, the payload it dispatches, the view it returns — is what
 * the assertions turn on, and no socket and no server stand behind any of it.
 *
 * Most of it needs no runtime either. `getPieceView()` is the exception: the
 * inspection it delegates to reads a cell's runtime, so that block builds one
 * over an emulated storage manager and doubles only the piece around it.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import type { PiecesController } from "@commonfabric/piece/ops";
import { Runtime, UI } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import {
  callPieceHandler,
  getPieceView,
  linkPieces,
  LinkValidationError,
  type PieceConfig,
  type PieceResolutionDeps,
  removePiece,
  setCellValue,
} from "../lib/piece.ts";
import { resetWriteReceipts } from "../lib/write-receipt.ts";

const SPACE = "did:key:z6MkjcdxtxTiUWkPkPffhs8ENkCcJjuRCQPpJFb2xyzwHqEk";
const PIECE = "fid1:connection-piece";

const config: PieceConfig = {
  apiUrl: "http://localhost:8000",
  space: SPACE,
  identity: "/nonexistent/keyfile",
  piece: PIECE,
};

/** The seam under test: a held connection, and no address lookup behind it. */
function over(pieces: PiecesController): PieceResolutionDeps {
  return {
    loadPieces: () => Promise.resolve(pieces),
    resolvePieceAddress: (_pieces, token) => Promise.resolve(token),
  };
}

/** Collects what a receipt writes, and restores the console afterwards. */
async function captureStderr(body: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    await body();
  } finally {
    console.error = original;
  }
  return lines;
}

describe("piece-connection", () => {
  describe("setCellValue()", () => {
    // One write per case, so the recorded write is the whole assertion: which
    // of the piece's two cells it landed on, at what path, with what value.

    interface CellWrite {
      cell: "input" | "result";
      value: unknown;
      path: (string | number)[];
    }

    function stubController(writes: CellWrite[]): PiecesController {
      const setter = (cell: "input" | "result") => ({
        set: (value: unknown, path: (string | number)[]) => {
          writes.push({ cell, value, path });
          return Promise.resolve();
        },
      });
      return {
        get: () =>
          Promise.resolve({
            input: setter("input"),
            result: setter("result"),
          }),
      } as unknown as PiecesController;
    }

    it("writes the value at the path on the result cell", async () => {
      resetWriteReceipts();
      const writes: CellWrite[] = [];
      const lines = await captureStderr(() =>
        setCellValue(
          config,
          ["items", 0, "title"],
          "Milk",
          undefined,
          over(stubController(writes)),
        )
      );
      expect(writes).toEqual([
        { cell: "result", value: "Milk", path: ["items", 0, "title"] },
      ]);
      expect(lines).toContain(`wrote to space ${SPACE}`);
    });

    it("writes to the arguments cell given `input`", async () => {
      resetWriteReceipts();
      const writes: CellWrite[] = [];
      await captureStderr(() =>
        setCellValue(
          config,
          ["title"],
          "Bread",
          { input: true },
          over(stubController(writes)),
        )
      );
      expect(writes).toEqual([
        { cell: "input", value: "Bread", path: ["title"] },
      ]);
    });
  });

  describe("removePiece()", () => {
    function stubController(
      removed: boolean,
      calls: string[] = [],
    ): PiecesController {
      return {
        remove: (id: string) => {
          calls.push(id);
          return Promise.resolve(removed);
        },
      } as unknown as PiecesController;
    }

    it("removes the piece the address resolved to", async () => {
      resetWriteReceipts();
      const calls: string[] = [];
      const lines = await captureStderr(() =>
        removePiece(config, {
          loadPieces: () => Promise.resolve(stubController(true, calls)),
          resolvePieceAddress: () => Promise.resolve("fid1:resolved"),
        })
      );
      expect(calls).toEqual(["fid1:resolved"]);
      expect(lines).toContain(`wrote to space ${SPACE}`);
    });

    it("throws naming the piece when the space held none", async () => {
      resetWriteReceipts();
      const lines = await captureStderr(async () => {
        await expect(removePiece(config, over(stubController(false))))
          .rejects.toThrow(`Piece "${PIECE}" not found`);
      });
      // A receipt claims the space changed, and nothing was removed.
      expect(lines).toEqual([]);
    });
  });

  describe("linkPieces()", () => {
    interface LinkCall {
      source: string;
      sourcePath: (string | number)[];
      target: string;
      targetPath: (string | number)[];
    }

    /**
     * Both endpoints carry a pattern identity, which is what the validation
     * reads to tell a piece from a cell that was merely written to, and hold
     * the values the paths are checked against.
     */
    function stubController(
      links: LinkCall[],
      cells: { source: unknown; target: unknown },
    ): PiecesController {
      const piece = (result: unknown, input: unknown) => ({
        getCell: () => ({
          getMetaRaw: () => ({ identity: "id-a", symbol: "default" }),
        }),
        result: { get: () => Promise.resolve(result) },
        input: { get: () => Promise.resolve(input) },
      });
      return {
        get: (id: string) =>
          Promise.resolve(
            id === "fid1:source"
              ? piece(cells.source, undefined)
              : piece(undefined, cells.target),
          ),
        link: (
          source: string,
          sourcePath: (string | number)[],
          target: string,
          targetPath: (string | number)[],
        ) => {
          links.push({ source, sourcePath, target, targetPath });
          return Promise.resolve();
        },
      } as unknown as PiecesController;
    }

    const endpoints = {
      source: { items: ["a"] },
      target: { feed: null },
    };

    it("links the resolved endpoints at the paths it checked", async () => {
      resetWriteReceipts();
      const links: LinkCall[] = [];
      const lines = await captureStderr(() =>
        linkPieces(
          config,
          "source-slug",
          ["items"],
          "target-slug",
          ["feed"],
          undefined,
          {
            loadPieces: () => Promise.resolve(stubController(links, endpoints)),
            resolvePieceAddress: (_pieces, token) =>
              Promise.resolve(
                token === "source-slug" ? "fid1:source" : "fid1:target",
              ),
          },
        )
      );
      expect(links).toEqual([{
        source: "fid1:source",
        sourcePath: ["items"],
        target: "fid1:target",
        targetPath: ["feed"],
      }]);
      expect(lines).toContain(`wrote to space ${SPACE}`);
    });

    it("refuses a path neither endpoint holds, and links nothing", async () => {
      const links: LinkCall[] = [];
      await expect(
        linkPieces(
          config,
          "fid1:source",
          ["missing"],
          "fid1:target",
          ["feed"],
          undefined,
          over(stubController(links, endpoints)),
        ),
      ).rejects.toThrow(LinkValidationError);
      expect(links).toEqual([]);
    });

    it("links a path neither endpoint holds under `allowNonExisting`", async () => {
      resetWriteReceipts();
      const links: LinkCall[] = [];
      await captureStderr(() =>
        linkPieces(
          config,
          "fid1:source",
          ["missing"],
          "fid1:target",
          ["feed"],
          { allowNonExisting: true },
          over(stubController(links, endpoints)),
        )
      );
      expect(links).toEqual([{
        source: "fid1:source",
        sourcePath: ["missing"],
        target: "fid1:target",
        targetPath: ["feed"],
      }]);
    });
  });

  describe("callPieceHandler()", () => {
    /**
     * The stream marker on the raw cell value is what classifies a name as a
     * handler, so `addItem` resolves and every other name reaches the end of
     * the resolution walk with nothing.
     */
    function stubController(sent: unknown[]): PiecesController {
      const handlerCell = {
        getRaw: () => ({ $stream: true }),
        get: () => ({ $stream: true }),
        send: (input: unknown, resolve: (tx: unknown) => void) => {
          sent.push(input);
          resolve({ status: () => ({ status: "done" }) });
        },
      };
      const plainCell = { getRaw: () => "Milk", get: () => "Milk" };
      const rootCell = {
        key: (name: string) => ({
          asSchemaFromLinks: () => name === "addItem" ? handlerCell : plainCell,
        }),
      };
      return {
        getSpace: () => SPACE,
        get: () =>
          Promise.resolve({
            getCell: () => ({}),
            input: { getCell: () => Promise.resolve(rootCell) },
            result: { getCell: () => Promise.resolve(rootCell) },
          }),
      } as unknown as PiecesController;
    }

    it("dispatches the payload to the named handler", async () => {
      resetWriteReceipts();
      const sent: unknown[] = [];
      const lines = await captureStderr(() =>
        callPieceHandler(
          config,
          "addItem",
          { title: "Milk" },
          {
            loadPieces: () => Promise.resolve(stubController(sent)),
            loadPiece: (pieces) => pieces.get(),
          },
        )
      );
      expect(sent).toEqual([{ title: "Milk" }]);
      expect(lines).toContain(`wrote to space ${SPACE}`);
    });

    it("throws naming a verb the piece does not expose", async () => {
      const sent: unknown[] = [];
      await expect(
        callPieceHandler(config, "title", {}, {
          loadPieces: () => Promise.resolve(stubController(sent)),
          loadPiece: (pieces) => pieces.get(),
        }),
      ).rejects.toThrow(`Callable "title" not found on piece ${PIECE}`);
      expect(sent).toEqual([]);
    });
  });

  describe("getPieceView()", () => {
    const view = { type: "vnode", name: "div", props: {}, children: [] };

    /**
     * An inspection reads both cells and their runtime, so the stub hands out
     * real cells from an emulated storage manager; only the piece around them
     * is a double.
     */
    async function withStub(
      result: unknown,
      body: (deps: PieceResolutionDeps) => Promise<void>,
    ): Promise<void> {
      const signer = await Identity.fromPassphrase("cli piece view test");
      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = new Runtime({
        apiUrl: new URL("https://example.com"),
        storageManager,
      });
      try {
        const space = signer.did();
        await body({
          resolvePieceAddress: (_pieces, token) => Promise.resolve(token),
          loadPieces: () =>
            Promise.resolve({
              get: () =>
                Promise.resolve({
                  id: PIECE,
                  name: () => "Notes",
                  getPatternRef: () => Promise.resolve(undefined),
                  input: {
                    get: () => Promise.resolve({}),
                    getCell: () =>
                      Promise.resolve(runtime.getCell(space, "argument")),
                  },
                  result: {
                    get: () => Promise.resolve(result),
                    getCell: () =>
                      Promise.resolve(runtime.getCell(space, "result")),
                  },
                  readingFrom: () => Promise.resolve([]),
                  readBy: () => Promise.resolve([]),
                }),
            } as any),
        });
      } finally {
        await runtime.dispose();
        await storageManager.close();
      }
    }

    it("returns the view node on the piece's result cell", async () => {
      await withStub({ title: "Notes", [UI]: view }, async (deps) => {
        expect(await getPieceView(config, deps)).toEqual(view);
      });
    });

    it("returns `undefined` for a piece that publishes no view", async () => {
      await withStub({ title: "Notes" }, async (deps) => {
        expect(await getPieceView(config, deps)).toBeUndefined();
      });
    });
  });
});
