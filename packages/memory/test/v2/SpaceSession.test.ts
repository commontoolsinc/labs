/**
 * Checks watch removal ordering through the memory server, with response gates
 * that hold a preceding acquisition open while cleanup is queued.
 */

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { defer } from "@commonfabric/utils/defer";

import {
  type ClientMessage,
  decodeMemoryBoundary,
  encodeMemoryBoundary,
  type ServerMessage,
  type WatchAddRequest,
  type WatchSetRequest,
  type WatchSpec,
} from "../../v2.ts";
import {
  type Client,
  connect,
  loopback,
  type SpaceSession,
  type Transport,
} from "../../v2/client.ts";
import { Server } from "../../v2/server.ts";
import {
  testSessionOpenAuthFactory,
  testSessionOpenServerOptions,
} from "../v2-auth-test-helpers.ts";

/** Builds a loopback with explicit watch-response holds and a cleanup failure. */
function controlledWatchLoopback(server: Server) {
  const inner = loopback(server);
  const requests: Array<WatchSetRequest | WatchAddRequest> = [];
  const holds = new Map<string, ReturnType<typeof defer<() => void>>>();
  let nextAddHold: ReturnType<typeof defer<() => void>> | undefined;
  let failNextSet = false;
  let receiver = (_payload: string) => {};
  const transport: Transport = {
    send(payload) {
      const message = decodeMemoryBoundary(payload) as ClientMessage;
      if (
        message.type === "session.watch.set" ||
        message.type === "session.watch.add"
      ) {
        requests.push(message);
        if (message.type === "session.watch.set" && failNextSet) {
          failNextSet = false;
          receiver(encodeMemoryBoundary({
            type: "response",
            requestId: message.requestId,
            error: { name: "Error", message: "injected cleanup failure" },
          }));
          return Promise.resolve();
        }
        if (message.type === "session.watch.add" && nextAddHold) {
          holds.set(message.requestId, nextAddHold);
          nextAddHold = undefined;
        }
      }
      return inner.send(payload);
    },
    close: () => inner.close(),
    setReceiver(next) {
      receiver = next;
      inner.setReceiver((payload) => {
        const message = decodeMemoryBoundary(payload) as ServerMessage;
        const hold = message.type === "response"
          ? holds.get(message.requestId)
          : undefined;
        if (hold && message.type === "response") {
          holds.delete(message.requestId);
          hold.resolve(() => receiver(payload));
        } else {
          receiver(payload);
        }
      });
    },
    setCloseReceiver: (next) => inner.setCloseReceiver?.(next),
  };
  return {
    transport,
    requests,
    failNextSet() {
      failNextSet = true;
    },
    holdNextAddResponse() {
      nextAddHold = defer<() => void>();
      return nextAddHold.promise;
    },
  };
}

/** Watches the whole document under a distinct subscription id. */
function rootSpec(id: string): WatchSpec {
  return {
    id,
    kind: "graph",
    query: { roots: [{ id, selector: { path: [], schema: false } }] },
  };
}

describe("SpaceSession", () => {
  const space = "did:key:z6Mk-watch-removal-order";
  let server: Server;
  let control: ReturnType<typeof controlledWatchLoopback>;
  let watcherClient: Client;
  let writerClient: Client;
  let watcher: SpaceSession;
  let writer: SpaceSession;

  beforeEach(async () => {
    server = new Server({
      ...testSessionOpenServerOptions,
      store: new URL("memory://watch-removal-order"),
      subscriptionRefreshDelayMs: "manual",
    });
    control = controlledWatchLoopback(server);
    watcherClient = await connect({ transport: control.transport });
    writerClient = await connect({ transport: loopback(server) });
    watcher = await watcherClient.mount(space, {}, testSessionOpenAuthFactory);
    writer = await writerClient.mount(space, {}, testSessionOpenAuthFactory);
  });

  afterEach(async () => {
    await watcherClient.close();
    await writerClient.close();
    await server.close();
  });

  describe("instance members", () => {
    describe("watchRemoveSync()", () => {
      for (const concurrent of [false, true]) {
        describe(`with concurrent refresh ${concurrent ? "enabled" : "disabled"}`, () => {
          for (const retry of [false, true]) {
            it(`keeps earlier and later acquisitions subscribed during ${retry ? "a cleanup retry" : "cleanup"}`, async () => {
              watcher.setConcurrentWatchRefresh(concurrent);
              const temporary = "of:temporary";
              const retained = ["of:kept", "of:earlier", "of:later"];
              await watcher.watchSetSync([
                rootSpec(temporary),
                rootSpec(retained[0]),
              ]);
              if (retry) {
                control.failNextSet();
                await expect(watcher.watchRemoveSync([temporary]))
                  .rejects.toThrow("injected cleanup failure");
              }

              const held = control.holdNextAddResponse();
              const earlier = watcher.watchAddSync([rootSpec(retained[1])]);
              const release = await held;
              // The server has installed the earlier watch, but the client
              // has not applied its response when we queue removal.
              const removal = watcher.watchRemoveSync([temporary]);
              const later = watcher.watchAddSync([rootSpec(retained[2])]);
              release();
              const [, , { view }] = await Promise.all([
                earlier,
                removal,
                later,
              ]);

              const updates = view.subscribe();
              await writer.transact({
                localSeq: 1,
                reads: { confirmed: [], pending: [] },
                operations: [...retained, temporary].map((id) => ({
                  op: "set" as const,
                  id,
                  value: { value: { n: 1 } },
                })),
              });
              await server.flushSessions([space]);
              const next = await updates.next();
              expect(next.done).toBe(false);
              expect(view.entities.map(({ id }) => id).sort()).toEqual(
                [...retained].sort(),
              );
              for (const entity of view.entities) {
                expect(entity.document).toEqual({ value: { n: 1 } });
              }

              const lastRequests = control.requests.slice(-3);
              expect(lastRequests.map(({ type }) => type)).toEqual([
                "session.watch.add",
                "session.watch.set",
                "session.watch.add",
              ]);
              expect(lastRequests[1].watches.map(({ id }) => id)).toEqual(
                retained.slice(0, 2),
              );
            });
          }
        });
      }
    });

    describe("watchAddSync()", () => {
      it("issues a second acquisition while the first response is held", async () => {
        watcher.setConcurrentWatchRefresh(true);
        const firstHeld = control.holdNextAddResponse();
        const first = watcher.watchAddSync([rootSpec("of:first")]);
        const releaseFirst = await firstHeld;
        const secondHeld = control.holdNextAddResponse();
        const second = watcher.watchAddSync([rootSpec("of:second")]);
        const releaseSecond = await secondHeld;
        releaseSecond();
        releaseFirst();
        await Promise.all([first, second]);
        await watcher.watchRemoveSync([]);
        expect(control.requests.at(-1)?.watches.map(({ id }) => id)).toEqual([
          "of:first",
          "of:second",
        ]);
      });
    });
  });
});
