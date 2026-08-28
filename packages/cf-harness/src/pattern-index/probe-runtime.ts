import type { Identity } from "@commonfabric/identity";
import { createSession } from "@commonfabric/identity";
import { PiecesController } from "@commonfabric/piece/ops";
import { Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

/**
 * An isolated runtime for the render gate's probe, and the reason it exists.
 *
 * The gate renders a second instance of a pattern to see what its `$UI` does.
 * Running that instance in the session's own space is not acceptable, and the
 * reason is stronger than it first appears: `runPersistent` allocates a
 * space-scoped entity and persists the probe's inputs, its piece metadata and
 * its whole result graph, and `runner.stop()` cancels execution and
 * subscriptions without deleting anything. Staying out of the piece registry
 * does not help either — Memory v2 enumerates live entities by id and the
 * FUSE projection hydrates them, so the orphan is reachable from inside the
 * sandbox. A pattern that reads the space through `wish()` would leave that
 * content there, which is exactly the case a synthetic-input argument does not
 * cover.
 *
 * Deleting what the probe creates was the alternative, and it was rejected for
 * a reason worth recording: a root-path retract does remove a document, but
 * the probe's settle produces derived documents beyond its piece and its
 * argument, and nothing here can enumerate them to establish that they are all
 * gone. That fix would have been "delete the ones we know about" presented as
 * "the leak is closed" — a narrower claim in a complete one's clothes, which
 * is the failure this gate exists to remove.
 *
 * So the boundary is structural. `StorageManager.emulate` holds everything in
 * memory, is never mounted anywhere, and is discarded on close: there is no
 * store for the probe to leak into rather than a cleanup that has to be got
 * exhaustively right.
 */
export interface ProbeRuntime {
  readonly pieces: PiecesController;

  /** Discards the runtime and, with it, everything the probe wrote. */
  close(): Promise<void>;
}

/**
 * Stands up a throwaway runtime and space for one probe.
 *
 * Returns `undefined` when the session carries no identity to act as — a
 * session built inline without one gets no isolated runtime, and the gate
 * abstains rather than falling back to probing in the live space. An honest
 * "not checked" beats a silent downgrade to the thing this module exists to
 * prevent.
 */
export const openProbeRuntime = async (
  identity: Identity | undefined,
  apiUrl: URL,
): Promise<ProbeRuntime | undefined> => {
  if (identity === undefined) return undefined;
  const storageManager = StorageManager.emulate({ as: identity });
  const runtime = new Runtime({ apiUrl, storageManager });
  try {
    const pieces = new PiecesController(
      await createSession({
        identity,
        spaceName: `render-probe-${crypto.randomUUID()}`,
      }),
      runtime,
    );
    await pieces.synced();
    return {
      pieces,
      async close() {
        await runtime.dispose();
        await storageManager.close();
      },
    };
  } catch (error) {
    await runtime.dispose().catch(() => {});
    await storageManager.close().catch(() => {});
    throw error;
  }
};
