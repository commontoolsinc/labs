import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import type { Cell } from "@commonfabric/runner";

import {
  PiecesController,
  registerNavigatedPiece,
} from "../src/ops/pieces-controller.ts";

const identity = await Identity.fromPassphrase(
  "pieces controller connection tests",
);

describe("pieces-controller", () => {
  describe("PiecesController", () => {
    describe("static members", () => {
      describe("initialize()", () => {
        const apiUrl = new URL("http://toolshed.test/");
        let requested: string[];
        let realFetch: typeof globalThis.fetch;

        beforeEach(() => {
          requested = [];
          realFetch = globalThis.fetch;
          globalThis.fetch = (input: string | URL | Request) => {
            requested.push(
              input instanceof Request ? input.url : input.toString(),
            );
            return Promise.resolve(new Response(null, { status: 503 }));
          };
        });

        afterEach(() => {
          globalThis.fetch = realFetch;
        });

        it("throws naming the API when the server is not healthy", async () => {
          await expect(PiecesController.initialize({
            apiUrl,
            identity,
            space: "unhealthy-space",
          })).rejects.toThrow('Could not connect to "http://toolshed.test/".');
        });

        it("asks the API for its health before reading the space", async () => {
          await expect(PiecesController.initialize({
            apiUrl,
            identity,
            space: "unhealthy-space",
          })).rejects.toThrow();
          expect(requested).toEqual(["http://toolshed.test/_health"]);
        });

        it("takes an apiUrl written as a string", async () => {
          await expect(PiecesController.initialize({
            apiUrl: "http://toolshed.test",
            identity,
            space: "unhealthy-space",
          })).rejects.toThrow('Could not connect to "http://toolshed.test/".');
        });

        it("throws the connection error for a space given as a `did:key:` DID", async () => {
          const spaceDid = (await Identity.fromPassphrase("a space of its own"))
            .did();
          await expect(PiecesController.initialize({
            apiUrl,
            identity,
            space: spaceDid,
          })).rejects.toThrow('Could not connect to "http://toolshed.test/".');
        });
      });
    });
  });

  describe("registerNavigatedPiece()", () => {
    // A piece cell is identified by its entity id, which `pieceId()` reads
    // through `cellEntityIdString`.
    const pieceCell = (id: string): Cell<unknown> =>
      ({ entityId: { "/": id } }) as unknown as Cell<unknown>;

    const controllerListing = (ids: string[]) => {
      const added: Cell<unknown>[][] = [];
      const pieces = {
        runtime: { storageManager: { synced: () => Promise.resolve() } },
        getPieceRegistry: () =>
          Promise.resolve({ get: () => ids.map(pieceCell) }),
        add: (newPieces: Cell<unknown>[]) => {
          added.push(newPieces);
          return Promise.resolve();
        },
      } as unknown as PiecesController;
      return { pieces, added };
    };

    it("adds a piece the registry does not list", async () => {
      const { pieces, added } = controllerListing(["already-here"]);
      const target = pieceCell("brand-new");
      await registerNavigatedPiece(pieces, target);
      expect(added).toEqual([[target]]);
    });

    it("leaves a piece the registry already lists alone", async () => {
      const { pieces, added } = controllerListing(["already-here"]);
      await registerNavigatedPiece(pieces, pieceCell("already-here"));
      expect(added).toEqual([]);
    });

    it("throws for a target carrying no piece id", async () => {
      const { pieces } = controllerListing([]);
      await expect(registerNavigatedPiece(pieces, {} as Cell<unknown>))
        .rejects.toThrow("navigateTo: the target carries no piece id");
    });
  });
});
