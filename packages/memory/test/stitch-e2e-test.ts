/**
 * End-to-end tests for the stitch sync protocol — full path from
 * StitchStorageProvider (client) through a real WebSocket to StitchHub
 * (server) backed by StitchDb.
 */

import { assertEquals } from "@std/assert";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { StitchHub } from "../stitch.ts";
import type { ClientMessage } from "../stitch.ts";
import { StitchStorageProvider } from "../../runner/src/storage/stitch-provider.ts";
import * as Subscription from "../../runner/src/storage/subscription.ts";
import type {
  ITransaction,
  MemorySpace,
  StorageNotification,
  URI,
} from "../../runner/src/storage/interface.ts";
import type { FabricDatum } from "@commontools/data-model/fabric-value";
import { assert as makeAssertion } from "../fact.ts";
import { createTemporaryDirectory } from "../util.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const THE = "application/json" as const;
const SPACE = "did:key:e2e-test" as MemorySpace;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal ITransaction suitable for StitchReplica.commit(). */
function makeTx(
  writes: Array<{ id: string; value: unknown }>,
  readIds: string[] = [],
): ITransaction {
  return {
    facts: writes.map(({ id, value }) =>
      makeAssertion({
        the: THE,
        of: id as URI,
        is: value as FabricDatum,
        cause: null,
      })
    ),
    claims: readIds.map((id) => ({
      the: THE,
      of: id as URI,
      // stitch-provider only uses claim.of, so the hash field is unused.
      fact: {} as never,
    })),
  };
}

/**
 * Start a minimal WebSocket server that routes connections to `hub`.
 * If `onMessage` is provided it is called for every raw message received,
 * before the message is forwarded to the hub.
 */
function startServer(
  hub: StitchHub,
  onMessage?: (raw: string) => void,
): {
  port: number;
  shutdown: () => Promise<void>;
} {
  const server = Deno.serve(
    { port: 0, hostname: "127.0.0.1", onListen: () => {} },
    (req) => {
      const space = new URL(req.url).searchParams.get("space") ?? SPACE;
      const { socket, response } = Deno.upgradeWebSocket(req);
      const { readable, writable } = hub.createSession(space);
      const writer = writable.getWriter();

      socket.onmessage = (e) => {
        const raw = e.data as string;
        onMessage?.(raw);
        writer.write(raw);
      };
      socket.onclose = () => writer.close().catch(() => {});
      socket.onerror = () => writer.close().catch(() => {});

      // Pump server-side messages to the socket.
      (async () => {
        const reader = readable.getReader();
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            if (socket.readyState === WebSocket.OPEN) socket.send(value);
          }
        } catch {
          // Ignore errors on cleanup.
        }
      })();

      return response;
    },
  );

  return {
    port: (server.addr as Deno.NetAddr).port,
    shutdown: () => server.shutdown(),
  };
}

/**
 * Open a StitchStorageProvider and wait for the underlying WebSocket to
 * establish before returning. We intercept the WebSocket constructor so we can
 * hook the `open` event and resolve a promise once the connection is ready.
 *
 * StitchConnection silently drops messages when the socket is not open, so
 * callers must not call sync() / commit() until this function resolves.
 */
async function openClient(port: number) {
  const sub = Subscription.create();
  const notifications: StorageNotification[] = [];
  sub.subscribe({
    next: (n) => {
      notifications.push(n);
      return { done: false };
    },
  });

  // Intercept WebSocket construction to track the open event.
  const OrigWebSocket = globalThis.WebSocket;
  let wsOpenPromise: Promise<void> = Promise.resolve();
  globalThis.WebSocket = class extends OrigWebSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols);
      let resolveOpen!: () => void;
      wsOpenPromise = new Promise<void>((r) => (resolveOpen = r));
      this.addEventListener("open", () => resolveOpen());
    }
  } as typeof WebSocket;

  const provider = new StitchStorageProvider({
    space: SPACE,
    address: new URL(`ws://127.0.0.1:${port}/`),
    subscription: sub,
  });

  // Restore the original WebSocket and wait for open.
  globalThis.WebSocket = OrigWebSocket;
  await wsOpenPromise;

  return { provider, notifications };
}

/**
 * Poll `predicate` every 10ms until it returns a truthy value or `timeoutMs`
 * has elapsed. Throws if the deadline is exceeded.
 */
async function waitFor<T>(
  predicate: () => T | undefined | null | false,
  timeoutMs = 2000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = predicate();
    if (result) return result as T;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("waitFor timed out");
}

/** Wait for at least `count` notifications of the given type. */
async function waitForNotifications(
  notifications: StorageNotification[],
  type: StorageNotification["type"],
  count = 1,
): Promise<StorageNotification[]> {
  await waitFor(() => {
    const matches = notifications.filter((n) => n.type === type);
    return matches.length >= count ? matches : null;
  });
  return notifications.filter((n) => n.type === type);
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("stitch e2e: client ↔ server", () => {
  let store: URL;
  let hub: StitchHub;
  let server: ReturnType<typeof startServer>;

  beforeEach(async () => {
    store = await createTemporaryDirectory();
    hub = new StitchHub(store);
    server = startServer(hub);
  });

  afterEach(async () => {
    await server.shutdown();
    await Deno.remove(store.pathname, { recursive: true });
  });

  // -------------------------------------------------------------------------
  // subscribe
  // -------------------------------------------------------------------------

  describe("subscribe", () => {
    it("sync() resolves once the server sends subscribed", async () => {
      const { provider } = await openClient(server.port);
      try {
        const result = await provider.sync("of:doc-a" as URI);
        assertEquals(result, { ok: {} });
      } finally {
        await provider.destroy();
      }
    });

    it("sync() populates the replica with the current doc value", async () => {
      // Seed the DB with a value using a first client.
      const { provider: seeder } = await openClient(server.port);
      try {
        await seeder.sync("of:counter" as URI);
        const tx = makeTx([{ id: "of:counter", value: { n: 42 } }]);
        const commitResult = await seeder.replica.commit(tx);
        assertEquals("ok" in commitResult, true);
      } finally {
        await seeder.destroy();
      }

      // A fresh client subscribing later should get the seeded value.
      const { provider: reader } = await openClient(server.port);
      try {
        await reader.sync("of:counter" as URI);
        const state = reader.replica.get({ id: "of:counter" as URI });
        assertEquals(state?.is, { n: 42 });
      } finally {
        await reader.destroy();
      }
    });
  });

  // -------------------------------------------------------------------------
  // commit
  // -------------------------------------------------------------------------

  describe("commit", () => {
    it("replica.commit() is accepted by the server and stored", async () => {
      const { provider, notifications } = await openClient(server.port);
      try {
        await provider.sync("of:greeting" as URI);

        const tx = makeTx([{ id: "of:greeting", value: "hello" }]);
        const result = await provider.replica.commit(tx);

        assertEquals("ok" in result, true);
        // The optimistic commit notification arrives before the server response.
        await waitForNotifications(notifications, "commit");
        assertEquals(
          provider.replica.get({ id: "of:greeting" as URI })?.is,
          "hello",
        );
      } finally {
        await provider.destroy();
      }
    });

    it("multiple sequential commits each get accepted", async () => {
      const { provider } = await openClient(server.port);
      try {
        await provider.sync("of:counter" as URI);

        for (let i = 0; i < 3; i++) {
          const tx = makeTx([{ id: "of:counter", value: { n: i } }]);
          const r = await provider.replica.commit(tx);
          assertEquals("ok" in r, true);
        }

        assertEquals(provider.replica.get({ id: "of:counter" as URI })?.is, {
          n: 2,
        });
      } finally {
        await provider.destroy();
      }
    });
  });

  // -------------------------------------------------------------------------
  // cross-client update propagation
  // -------------------------------------------------------------------------

  describe("cross-client update propagation", () => {
    it("subscriber receives an integrate notification when another client commits", async () => {
      const { provider: writer } = await openClient(server.port);
      const { provider: reader, notifications: readerNotifs } =
        await openClient(
          server.port,
        );
      try {
        // Reader subscribes first.
        await reader.sync("of:shared" as URI);

        // Writer commits a value.
        await writer.sync("of:shared" as URI);
        const tx = makeTx([{ id: "of:shared", value: { msg: "broadcast" } }]);
        await writer.replica.commit(tx);

        // Reader should receive an integrate notification.
        const [notif] = await waitForNotifications(readerNotifs, "integrate");
        assertEquals(notif.type, "integrate");
        assertEquals(
          reader.replica.get({ id: "of:shared" as URI })?.is,
          { msg: "broadcast" },
        );
      } finally {
        await writer.destroy();
        await reader.destroy();
      }
    });

    it("non-subscriber does not receive an integrate notification", async () => {
      const { provider: writer } = await openClient(server.port);
      const { provider: bystander, notifications: bystanderNotifs } =
        await openClient(
          server.port,
        );
      try {
        // Bystander subscribes to a different doc.
        await bystander.sync("of:other" as URI);

        // Writer commits to a doc the bystander never subscribed to.
        await writer.sync("of:unrelated" as URI);
        const tx = makeTx([{ id: "of:unrelated", value: 1 }]);
        await writer.replica.commit(tx);

        // Give the event loop time to propagate any (incorrect) notifications.
        await new Promise((r) => setTimeout(r, 100));

        const integrateNotifs = bystanderNotifs.filter((n) =>
          n.type === "integrate"
        );
        assertEquals(integrateNotifs.length, 0);
      } finally {
        await writer.destroy();
        await bystander.destroy();
      }
    });
  });

  // -------------------------------------------------------------------------
  // conflict detection and revert
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // selector forwarding
  // -------------------------------------------------------------------------

  describe("selector forwarding", () => {
    it("sync() sends the default selector when none is provided", async () => {
      const received: ClientMessage[] = [];
      const srv = startServer(hub, (raw) => {
        received.push(JSON.parse(raw) as ClientMessage);
      });
      try {
        const { provider } = await openClient(srv.port);
        await provider.sync("of:doc" as URI);
        await provider.destroy();

        const sub = received.find((m) => m.type === "subscribe");
        assertEquals(sub?.type, "subscribe");
        assertEquals(
          (sub as Extract<ClientMessage, { type: "subscribe" }>).selector[
            "of:doc"
          ],
          { schema: true, path: [] },
        );
      } finally {
        await srv.shutdown();
      }
    });

    it("sync() forwards a custom selector to the subscribe message", async () => {
      const received: ClientMessage[] = [];
      const srv = startServer(hub, (raw) => {
        received.push(JSON.parse(raw) as ClientMessage);
      });
      try {
        const customSelector = {
          path: ["name"],
          schema: { type: "string" } as const,
        };
        const { provider } = await openClient(srv.port);
        await provider.sync("of:doc" as URI, customSelector);
        await provider.destroy();

        const sub = received.find((m) => m.type === "subscribe");
        assertEquals(
          (sub as Extract<ClientMessage, { type: "subscribe" }>).selector[
            "of:doc"
          ],
          customSelector,
        );
      } finally {
        await srv.shutdown();
      }
    });
  });

  describe("conflict detection", () => {
    it("stale read causes rejection and reverts the optimistic update", async () => {
      // Writer advances the server to serverSeq ≥ 1 by writing "of:doc".
      const { provider: writer } = await openClient(server.port);

      // Open the stale client *before* any subscribe, so its #serverSeq is 0.
      // openClient() only waits for the WebSocket open event — no sync() call.
      const { provider: stale, notifications: staleNotifs } = await openClient(
        server.port,
      );

      try {
        // Writer subscribes and commits to "of:doc", advancing serverSeq to 1.
        await writer.sync("of:doc" as URI);
        const tx = makeTx([{ id: "of:doc", value: "written" }]);
        await writer.replica.commit(tx);

        // Stale now commits with "of:doc" in its readSet at serverSeq=0.
        // The server should reject: "of:doc" was written at serverSeq=1 > 0.
        const staleTx = makeTx(
          [{ id: "of:result", value: "stale-value" }],
          ["of:doc"], // stale read: "of:doc" changed since serverSeq 0
        );
        const result = await stale.replica.commit(staleTx);

        // Server must reject the stale commit.
        assertEquals("error" in result, true);

        // The optimistic update in the replica must have been reverted.
        const revertNotifs = await waitForNotifications(staleNotifs, "revert");
        assertEquals(revertNotifs.length >= 1, true);
        assertEquals(stale.replica.get({ id: "of:result" as URI }), undefined);
      } finally {
        await writer.destroy();
        await stale.destroy();
      }
    });
  });
});
