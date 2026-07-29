/**
 * Tier 2 of the pattern-update regime: prove a new pattern can still READ the
 * state an older version of itself wrote.
 *
 * Tier 1 (`deno task pattern-compat`) proves the argument/result contract is
 * backward compatible. That is a statement about schemas, and schemas do not
 * describe everything a pattern writes — data under keys the new version drops
 * or renames becomes unreachable with no schema change at all, and the CFC
 * additive-required migration refuses a setup commit for a required field with
 * no default (the 2026-07-22 estuary brick) without either contract being
 * "incompatible". Only replaying a real prior state catches those.
 *
 * The state is captured as a **SQLite space store**, not a bespoke JSON dump.
 * A space is one SQLite file, `snapshotSpaceStore` already writes a
 * crash-consistent copy of one, and restoring is a file copy — where a JSON
 * dump would need a re-writer that reconstructs docs, causes and links, and
 * getting causes wrong silently produces a fixture that is not the state that
 * was captured.
 *
 * Capture is deliberately file-backed: `StorageManager.emulate` runs a real
 * memory server against `:memory:`, which has no file to snapshot.
 */

import { fromFileUrl } from "@std/path/from-file-url";
import { Identity } from "@commonfabric/identity";
import * as MemoryV2Client from "@commonfabric/memory/v2/client";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";
import {
  snapshotSpaceStore,
  spaceStorePath,
} from "@commonfabric/memory/v2/dump";
import { resolveSpaceStoreUrl } from "@commonfabric/memory/v2/storage-path";
import type { Signer } from "@commonfabric/memory/interface";
import {
  type Options,
  type SessionFactory,
  StorageManager,
} from "../../runner/src/storage/v2.ts";
import { type Cell, Runtime } from "@commonfabric/runner";
import type { RuntimeProgram } from "@commonfabric/runner";
// Relative into the runner's test utilities: they are not part of the runner's
// public exports, and the loopback-server auth handshake has exactly one
// correct spelling — duplicating it here would be a second copy to drift.
import {
  TEST_MEMORY_SERVER_AUTH,
  testPrincipalSessionOpenAuthFactory,
} from "../../runner/test/memory-v2-test-utils.ts";

class LoopbackSessions implements SessionFactory {
  constructor(private readonly server: () => MemoryV2Server.Server) {}
  async create(spaceId: string, signer?: Signer) {
    const client = await MemoryV2Client.connect({
      transport: MemoryV2Client.loopback(this.server()),
    });
    const session = await client.mount(
      spaceId,
      {},
      testPrincipalSessionOpenAuthFactory(signer),
    );
    return { client, session };
  }
}

class FileBackedStorageManager extends StorageManager {
  static make(as: Identity, server: MemoryV2Server.Server) {
    return new FileBackedStorageManager(
      { as, memoryHost: new URL("memory://") } as Options,
      server,
    );
  }
  private constructor(options: Options, server: MemoryV2Server.Server) {
    super(options, new LoopbackSessions(() => server));
  }
  override registerSpaceHost(): boolean {
    return false;
  }
}

function serverOver(storeDir: string): MemoryV2Server.Server {
  return new MemoryV2Server.Server({
    authorizeSessionOpen(message) {
      const principal = (message.authorization as { principal?: unknown })
        ?.principal;
      return typeof principal === "string" ? principal : undefined;
    },
    sessionOpenAuth: TEST_MEMORY_SERVER_AUTH.sessionOpenAuth,
    store: new URL(`file://${storeDir}/`),
  });
}

export interface VintageRuntime {
  runtime: Runtime;
  space: string;
  storeDir: string;
  /** Snapshot this space to `destPath`. Crash-consistent, runs no migrations. */
  snapshot(destPath: string): Promise<void>;
  dispose(): Promise<void>;
}

/**
 * A runtime whose space lives in a real file, so it can be snapshotted.
 *
 * `storeDir` is the caller's to clean up. Pass an existing `fromSnapshot` to
 * start from a captured vintage instead of an empty space.
 */
export async function openFileBackedRuntime(
  signer: Identity,
  storeDir: string,
  fromSnapshot?: string,
): Promise<VintageRuntime> {
  const space = signer.did();
  const storeUrl = new URL(`file://${storeDir}/`);

  if (fromSnapshot !== undefined) {
    // Place the snapshot where the engine resolves this space's store. The
    // path encodes the DID, and restoring under the SAME DID is deliberate:
    // re-keying is an unbounded migration that would destroy the fidelity the
    // fixture exists to buy (CFC labels name the space, among other things).
    await seedSpaceStore(storeDir, space, fromSnapshot);
  }

  const server = serverOver(storeDir);
  const storageManager = FileBackedStorageManager.make(signer, server);
  const runtime = new Runtime({
    apiUrl: new URL("http://toolshed.test"),
    storageManager,
  });

  return {
    runtime,
    space,
    storeDir,
    async snapshot(destPath: string) {
      // Everything must be durable before the copy, or the fixture records a
      // state the capture never actually reached.
      await runtime.idle();
      await runtime.storageManager.synced();
      const path = spaceStorePath(storeUrl, space);
      if (path === null) {
        throw new Error(
          `no space store for ${space} under ${storeDir} — nothing was written`,
        );
      }
      snapshotSpaceStore(path, destPath);
    },
    async dispose() {
      await runtime.dispose();
      await storageManager.close();
    },
  };
}

/**
 * Copy a snapshot into the place the engine looks for `space`'s store.
 *
 * The layout is resolved with `resolveSpaceStoreUrl`, the same helper the
 * server resolves through — directory mode nests one level deeper than
 * single-file mode, and rebuilding that rule here would rot silently. Note it
 * COMPUTES a path rather than stat-ing one, which is what this needs: the
 * destination does not exist yet.
 */
async function seedSpaceStore(
  storeDir: string,
  space: string,
  snapshotPath: string,
): Promise<void> {
  const target = fromFileUrl(
    resolveSpaceStoreUrl(new URL(`file://${storeDir}/`), space as never),
  );
  await Deno.mkdir(target.slice(0, target.lastIndexOf("/")), {
    recursive: true,
  });
  await Deno.copyFile(snapshotPath, target);
}

/**
 * A stable root cell for a captured space.
 *
 * The cause is fixed rather than minted, because `PieceManager.setupPersistent`
 * otherwise defaults to `{ space, random: crypto.randomUUID() }` and the root's
 * entity id would differ on every capture — the fixture could then never be
 * re-read by id. (Root creation through `ensureDefaultPattern` bakes
 * `Date.now()` into its cause for the same reason, so a root fixture has to go
 * around that path.)
 */
export const VINTAGE_ROOT_CAUSE = { stateContinuity: "vintage-root" } as const;

export function vintageRoot<T>(
  vintage: VintageRuntime,
  schema: unknown,
): Cell<T> {
  return vintage.runtime.getCell<T>(
    vintage.space as never,
    VINTAGE_ROOT_CAUSE,
    schema as never,
  );
}

export type { RuntimeProgram };
