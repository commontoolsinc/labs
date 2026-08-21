// The serving runtime's loopback storage plane (server-execution v2
// stage F, serving-loop.md §1 plane (a)): a StorageManager whose sessions
// connect IN-PROCESS to the co-hosted memory server — the ONLY commit
// path the loop's runtime uses — with the SAME signed `session.open`
// production clients present. No parallel auth scheme: the loopback
// session's principal is the service identity, verified by whatever
// `authorizeSessionOpen` the host process configured, which is exactly
// what makes the read-row admission's holder matching (protocol.md §2)
// meaningful in production.

import type { MemorySpace, Signer } from "@commonfabric/memory/interface";
import * as MemoryClient from "@commonfabric/memory/v2/client";
import type { Server as MemoryServer } from "@commonfabric/memory/v2/server";
import {
  type Options,
  type SessionFactory,
  StorageManager,
} from "../storage/v2.ts";
import { createSignedSessionOpenAuth } from "../storage/v2-remote-session.ts";

class LoopbackSessionFactory implements SessionFactory {
  readonly supportsAclBootstrap = true;

  constructor(private readonly getServer: () => MemoryServer) {}

  async create(
    space: MemorySpace,
    signer?: Signer,
    mountOptions: MemoryClient.MountOptions = {},
  ) {
    if (signer === undefined) {
      throw new Error(
        "loopback serving sessions require the service identity signer",
      );
    }
    const client = await MemoryClient.connect({
      transport: MemoryClient.loopback(this.getServer()),
    });
    try {
      const session = await client.mount(
        space,
        mountOptions,
        (
          targetSpace: string,
          descriptor: MemoryClient.MountOptions,
          context: MemoryClient.SessionOpenAuthContext,
        ) =>
          createSignedSessionOpenAuth(
            signer,
            targetSpace as MemorySpace,
            descriptor,
            context,
          ),
      );
      return { client, session };
    } catch (error) {
      // A failed mount must not leak the in-process connection (repeated
      // auth/transient failures would accumulate server-side sessions) —
      // the same close-before-rethrow RemoteSessionFactory.create does.
      await client.close().catch(() => {});
      throw error;
    }
  }
}

/**
 * The SpaceServer's storage manager: in-process transport, signed
 * session-open, the service identity as `as`. One manager per serving
 * runtime (per space activation) — the ExecutorHost's runtime factory
 * constructs and disposes it with the runtime.
 */
export class LoopbackStorageManager extends StorageManager {
  static connect(
    server: MemoryServer,
    options: Omit<Options, "memoryHost" | "spaceHostMap">,
  ): LoopbackStorageManager {
    return new LoopbackStorageManager(
      {
        ...options,
        // Placeholder: the loopback session factory never resolves a
        // storage address against this.
        memoryHost: new URL("memory://loopback"),
      },
      new LoopbackSessionFactory(() => server),
    );
  }

  /**
   * Loopback sessions are in-process — there is no per-space host to
   * resolve, so a site-table host hint can never take effect. Refuse
   * honestly (as the emulated loopback manager does) rather than accept
   * a registration that resets the provisional replica while every new
   * session still uses the co-hosted server.
   */
  override registerSpaceHost(): boolean {
    return false;
  }
}
