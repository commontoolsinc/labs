/**
 * Unit tests for the connection a shuttle process holds. Every case stands a
 * `HeldConnection` over an opener of its own, so what is under test is the
 * holding — when a connection is opened, how many times, which one every ask
 * gets, and who closes it — with no socket, no server and no clock anywhere
 * behind it. What `loadPieces` does once called is not this file's subject.
 *
 * Two bounds on what these cases pin are worth stating, because both look
 * covered from the descriptions alone.
 *
 * The cases around a failed construction pin a connection that never opened.
 * None of them says anything about a connection that opens and later drops:
 * the module holds no opinion about one, so there is nothing here to pin.
 *
 * And no case drives the guard in `pieces()` that clears the memo only while
 * the failing attempt is still the held one. Two writers touch that memo — an
 * ask, which holds an attempt, and that attempt's own failure, which unholds
 * it; disposal reads it and never writes. An ask starts a second attempt only
 * where nothing is held, and only a failure unholds, so every failure runs the
 * guard while its own attempt is still the held one and the guard's other
 * branch is unreachable from outside. An unconditional clear would behave
 * identically at every door, which is why no case can tell them apart. The
 * guard stays as what keeps the memo safe to unhold from somewhere other than
 * a failure, and this paragraph is read again if anything ever unholds it.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import type { SpaceConfig } from "@commonfabric/cli/lib/piece";
import type { PiecesController } from "@commonfabric/piece/ops";

import {
  type ConnectionOpener,
  type ConnectionRecord,
  type ConnectionSource,
  HeldConnection,
} from "../src/connection.ts";

const RECORD: ConnectionRecord = {
  apiUrl: "https://toolshed.example/",
  space: "did:key:z6MkConnectedSpace",
  identity: "/keys/shuttle.pkcs8",
};

/** What {@link stubController} hands a case. */
interface StubController {
  /** The controller a connection serves and may close. */
  readonly pieces: PiecesController;

  /** How many times it has been closed. */
  closed(): number;
}

/**
 * Helper for the cases below, which stands in for the controller a connection
 * carries. Nothing here reads a controller, so it reports one thing only —
 * how many times it was closed — which is what every ownership case turns on.
 *
 * A `closeError` makes its close fail, which is the second observable a case
 * has of the closing: a failure only reaches a caller of `dispose()` through
 * an `await`, so it separates a close that is awaited from one that is
 * merely started, where the count alone cannot.
 */
function stubController(closeError?: Error): StubController {
  let closed = 0;
  const pieces = {
    dispose: () => {
      closed += 1;
      return closeError === undefined
        ? Promise.resolve()
        : Promise.reject(closeError);
    },
  } as unknown as PiecesController;
  return { pieces, closed: () => closed };
}

/** Helper for the cases below, which names a source `open` opens. */
function owning(open: ConnectionOpener): ConnectionSource {
  return { kind: "owned", record: RECORD, open };
}

describe("connection", () => {
  describe("HeldConnection", () => {
    describe("constructor()", () => {
      it("opens nothing until a connection is asked for", () => {
        let calls = 0;
        new HeldConnection(owning(() => {
          calls += 1;
          return Promise.resolve(stubController().pieces);
        }));
        expect(calls).toBe(0);
      });
    });

    describe("instance members", () => {
      describe("pieces()", () => {
        it("returns the same connection for every ask, having opened one", async () => {
          const controller = stubController();
          let calls = 0;
          const connection = new HeldConnection(owning(() => {
            calls += 1;
            return Promise.resolve(controller.pieces);
          }));
          const first = connection.pieces();
          const second = connection.pieces();
          expect(second).toBe(first);
          expect(await first).toBe(controller.pieces);
          expect(calls).toBe(1);
        });

        it("returns the connection it opened to an ask made after the construction settles", async () => {
          const controller = stubController();
          let calls = 0;
          const connection = new HeldConnection(owning(() => {
            calls += 1;
            return Promise.resolve(controller.pieces);
          }));
          expect(await connection.pieces()).toBe(controller.pieces);
          expect(await connection.pieces()).toBe(controller.pieces);
          expect(calls).toBe(1);
        });

        it("opens with the `SpaceConfig` the record denotes, carrying the record's three dimensions and nothing else", async () => {
          const controller = stubController();
          const configs: SpaceConfig[] = [];
          const connection = new HeldConnection(owning((config) => {
            configs.push(config);
            return Promise.resolve(controller.pieces);
          }));
          await connection.pieces();
          expect(configs).toEqual([{
            apiUrl: RECORD.apiUrl,
            space: RECORD.space,
            identity: RECORD.identity,
          }]);
        });

        it("joins a construction already in flight rather than starting a second one", async () => {
          const controller = stubController();
          const opening = Promise.withResolvers<PiecesController>();
          let calls = 0;
          const connection = new HeldConnection(owning(() => {
            calls += 1;
            return opening.promise;
          }));
          const first = connection.pieces();
          const second = connection.pieces();
          opening.resolve(controller.pieces);
          expect(await first).toBe(controller.pieces);
          expect(await second).toBe(controller.pieces);
          expect(calls).toBe(1);
        });

        it("opens again on the next ask once a construction rejects", async () => {
          const controller = stubController();
          let calls = 0;
          const connection = new HeldConnection(owning(() => {
            calls += 1;
            return calls === 1
              ? Promise.reject(new Error("no route to the deployment"))
              : Promise.resolve(controller.pieces);
          }));
          await expect(connection.pieces()).rejects.toThrow(
            "no route to the deployment",
          );
          expect(await connection.pieces()).toBe(controller.pieces);
          expect(calls).toBe(2);
        });

        it("returns a rejection where the opener throws rather than throwing at the ask", async () => {
          const connection = new HeldConnection(owning(() => {
            throw new Error("no identity at that path");
          }));
          const asked = connection.pieces();
          await expect(asked).rejects.toThrow("no identity at that path");
        });

        it("throws once the connection is disposed", async () => {
          const controller = stubController();
          const connection = new HeldConnection(
            owning(() => Promise.resolve(controller.pieces)),
          );
          await connection.pieces();
          await connection.dispose();
          expect(() => connection.pieces()).toThrow(
            "This connection is disposed.",
          );
        });
      });

      describe("dispose()", () => {
        it("closes the connection it opened", async () => {
          const controller = stubController();
          {
            await using connection = new HeldConnection(
              owning(() => Promise.resolve(controller.pieces)),
            );
            await connection.pieces();
          }
          expect(controller.closed()).toBe(1);
        });

        it("leaves a connection it was handed open", async () => {
          const controller = stubController();
          const connection = new HeldConnection({
            kind: "borrowed",
            pieces: controller.pieces,
          });
          expect(await connection.pieces()).toBe(controller.pieces);
          await connection.dispose();
          expect(controller.closed()).toBe(0);
        });

        it("closes nothing where no ask opened a connection", async () => {
          const controller = stubController();
          let calls = 0;
          const connection = new HeldConnection(owning(() => {
            calls += 1;
            return Promise.resolve(controller.pieces);
          }));
          await connection.dispose();
          expect(calls).toBe(0);
          expect(controller.closed()).toBe(0);
        });

        it("closes the connection once across repeated disposals", async () => {
          const controller = stubController();
          const connection = new HeldConnection(
            owning(() => Promise.resolve(controller.pieces)),
          );
          await connection.pieces();
          await connection.dispose();
          await connection.dispose();
          expect(controller.closed()).toBe(1);
        });

        it("returns the same disposal to a call made while the first is running", async () => {
          const controller = stubController();
          const opening = Promise.withResolvers<PiecesController>();
          const connection = new HeldConnection(owning(() => opening.promise));
          const asked = connection.pieces();
          const first = connection.dispose();
          const second = connection.dispose();
          expect(second).toBe(first);
          opening.resolve(controller.pieces);
          expect(await asked).toBe(controller.pieces);
          await second;
          expect(controller.closed()).toBe(1);
        });

        it("returns the failure a close raises", async () => {
          const controller = stubController(
            new Error("socket teardown failed"),
          );
          const connection = new HeldConnection(
            owning(() => Promise.resolve(controller.pieces)),
          );
          await connection.pieces();
          await expect(connection.dispose()).rejects.toThrow(
            "socket teardown failed",
          );
        });

        it("returns the failure a close raises where the construction was still in flight", async () => {
          const controller = stubController(
            new Error("socket teardown failed"),
          );
          const opening = Promise.withResolvers<PiecesController>();
          const connection = new HeldConnection(owning(() => opening.promise));
          const asked = connection.pieces();
          const disposing = connection.dispose();
          opening.resolve(controller.pieces);
          expect(await asked).toBe(controller.pieces);
          await expect(disposing).rejects.toThrow("socket teardown failed");
        });

        it("returns the same failure to a disposal asked for again", async () => {
          const controller = stubController(
            new Error("socket teardown failed"),
          );
          const connection = new HeldConnection(
            owning(() => Promise.resolve(controller.pieces)),
          );
          await connection.pieces();
          await expect(connection.dispose()).rejects.toThrow(
            "socket teardown failed",
          );
          await expect(connection.dispose()).rejects.toThrow(
            "socket teardown failed",
          );
          expect(controller.closed()).toBe(1);
        });

        it("closes a construction that was still in flight when disposal began", async () => {
          const controller = stubController();
          const opening = Promise.withResolvers<PiecesController>();
          const connection = new HeldConnection(owning(() => opening.promise));
          const asked = connection.pieces();
          const disposing = connection.dispose();
          opening.resolve(controller.pieces);
          expect(await asked).toBe(controller.pieces);
          await disposing;
          expect(controller.closed()).toBe(1);
        });

        it("returns rather than re-raising a construction in flight that then fails", async () => {
          const opening = Promise.withResolvers<PiecesController>();
          const connection = new HeldConnection(owning(() => opening.promise));
          const asked = connection.pieces();
          const disposing = connection.dispose();
          opening.reject(new Error("no route to the deployment"));
          await expect(asked).rejects.toThrow("no route to the deployment");
          await disposing;
        });
      });
    });
  });
});
