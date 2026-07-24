import { assert, assertEquals } from "@std/assert";
import { Identity } from "@commonfabric/identity";
import type { MemorySpace, Signer, URI } from "@commonfabric/memory/interface";
import * as MemoryV2Client from "@commonfabric/memory/v2/client";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";
import {
  decodeMemoryBoundary,
  encodeMemoryBoundary,
} from "@commonfabric/memory/v2";
import type { SessionFactory } from "../src/storage/v2.ts";
import {
  TEST_MEMORY_SERVER_AUTH,
  testPrincipalSessionOpenAuthFactory,
  TestStorageManager,
} from "./memory-v2-test-utils.ts";

function makeServer(): MemoryV2Server.Server {
  return new MemoryV2Server.Server({
    authorizeSessionOpen(m) {
      const p = (m.authorization as { principal?: unknown })?.principal;
      return typeof p === "string" ? p : undefined;
    },
    sessionOpenAuth: TEST_MEMORY_SERVER_AUTH.sessionOpenAuth,
  });
}

/**
 * A session whose handshake and session.open succeed against a real server, but
 * whose `session.watch.add` — the request a pull issues — is answered directly
 * with an `AuthorizationError` response instead of being forwarded. This is the
 * denial the storage layer must surface from `synced()`: the watch (and thus the
 * pull, and thus the sync) fails authorization.
 */
class DenyingWatchSessionFactory implements SessionFactory {
  constructor(
    private readonly server: MemoryV2Server.Server,
    private readonly retriable: boolean,
  ) {}

  async create(id: string, signer?: Signer) {
    const base = MemoryV2Client.loopback(this.server);
    let receive: (payload: string) => void = () => {};
    const transport: MemoryV2Client.Transport = {
      send: (payload: string) => {
        const message = decodeMemoryBoundary(payload) as {
          type?: string;
          requestId?: string;
        };
        if (message.type === "session.watch.add") {
          receive(encodeMemoryBoundary({
            type: "response",
            requestId: message.requestId!,
            error: {
              name: "AuthorizationError",
              message: "Principal lacks READ on space",
              ...(this.retriable ? { retriable: true } : {}),
            },
          }));
          return Promise.resolve();
        }
        return base.send(payload);
      },
      close: () => base.close(),
      setReceiver: (r) => {
        receive = r;
        base.setReceiver(r);
      },
      setCloseReceiver: (r) => base.setCloseReceiver?.(r),
    };
    const client = await MemoryV2Client.connect({ transport });
    const session = await client.mount(
      id as MemorySpace,
      {},
      testPrincipalSessionOpenAuthFactory(signer),
    );
    return { client, session };
  }
}

Deno.test(
  "authorizationError() surfaces a permanent watch denial for the space",
  async () => {
    const signer = await Identity.fromPassphrase("storage-synced-authz-perm");
    const storage = TestStorageManager.create(
      { as: signer, memoryHost: new URL("memory://") },
      new DenyingWatchSessionFactory(makeServer(), false),
    );

    try {
      const provider = storage.open(signer.did());
      void provider.sync("of:storage-synced-authz-perm" as URI);

      // synced() stays quiet — a denied read is a silent absent read at the sync
      // barrier — but the per-space status carries the real, throwable error.
      await storage.synced();
      const error = storage.authorizationError(signer.did());
      assert(error !== undefined);
      assertEquals(error.name, "AuthorizationError");
      assert(error.message.includes("lacks READ"));
    } finally {
      await storage.close();
    }
  },
);

Deno.test(
  "authorizationError() stays undefined on a retriable authorization race",
  async () => {
    const signer = await Identity.fromPassphrase("storage-synced-authz-retry");
    const storage = TestStorageManager.create(
      { as: signer, memoryHost: new URL("memory://") },
      new DenyingWatchSessionFactory(makeServer(), true),
    );

    try {
      const provider = storage.open(signer.did());
      void provider.sync("of:storage-synced-authz-retry" as URI);

      // A retriable auth race (an anti-replay handshake failure a fresh
      // reconnect heals) is not a permanent denial, so nothing is surfaced.
      await storage.synced();
      assertEquals(storage.authorizationError(signer.did()), undefined);
    } finally {
      await storage.close();
    }
  },
);
