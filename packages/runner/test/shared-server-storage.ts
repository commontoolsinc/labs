import type { Identity } from "@commonfabric/identity";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { defaultSettings, type Options } from "../src/storage/v2.ts";
import { Runtime } from "../src/runtime.ts";
import { TEST_MEMORY_SERVER_AUTH } from "./memory-v2-test-utils.ts";

/**
 * An in-process memory server the caller owns, so several managers can be
 * pointed at one space: one to populate it, and one that starts empty and has
 * to pull whatever it reads.
 */
export function makeSharedServer(): MemoryV2Server.Server {
  return new MemoryV2Server.Server({
    authorizeSessionOpen(message) {
      const principal = (message.authorization as { principal?: unknown })
        ?.principal;
      return typeof principal === "string" ? principal : undefined;
    },
    sessionOpenAuth: TEST_MEMORY_SERVER_AUTH.sessionOpenAuth,
  });
}

/**
 * A manager on a server the caller owns. About twenty runner tests carry a
 * private copy of this; it is the same shape, with the storage settings opened
 * up so a test can choose them.
 */
export class SharedServerStorageManager extends EmulatedStorageManager {
  static connectTo(
    server: MemoryV2Server.Server,
    options: Omit<Options, "memoryHost" | "spaceHostMap">,
  ): SharedServerStorageManager {
    const manager = new SharedServerStorageManager(
      { ...options, memoryHost: new URL("memory://") },
      () => server,
    );
    manager.sharedServer = server;
    return manager;
  }

  private sharedServer!: MemoryV2Server.Server;

  // The server is SHARED between managers and closed once by the caller — serve
  // it without ever initializing the base class's private `#server`, whose
  // `close()` would otherwise close the shared server once per manager.
  protected override server(): MemoryV2Server.Server {
    return this.sharedServer;
  }
}

/** A runtime on its own replica of `server`. */
export function openSharedServerRuntime(
  as: Identity,
  server: MemoryV2Server.Server,
  experimentalDocumentRelease = false,
): { manager: SharedServerStorageManager; runtime: Runtime } {
  const manager = SharedServerStorageManager.connectTo(server, {
    as,
    settings: { ...defaultSettings, experimentalDocumentRelease },
  } as Omit<Options, "memoryHost" | "spaceHostMap">);
  return {
    manager,
    runtime: new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: manager,
    }),
  };
}
