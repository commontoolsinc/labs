import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Logger, type LogMessage } from "@commonfabric/utils/logger";

import { seedResultContainerWhenPullSettles } from "../src/builtins/list-result-container-seed.ts";
import type { Cell } from "../src/cell.ts";
import { Runtime } from "../src/runtime.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";

// The seed is the list coordinators' recovery for a result container that was
// never persisted: the resume reconcile defers on an undefined container and
// pulls it, and a pull that settles with the container still undefined leaves
// nothing on its way to re-trigger the reconcile.
//
// These cases drive the recovery's outcomes and both of its failure reports.
// The reports otherwise run only where a suite happens to tear a runtime down
// while a container write is in flight, so they flip between covered and
// uncovered across identical CI runs. Each case here constructs the failure it
// wants and pins the report the recovery produces from it.

const signer = await Identity.fromPassphrase("list result container seed");
const space = signer.did();

/** A logger that keeps every warning rather than printing it. */
class RecordingLogger extends Logger {
  readonly warnings: Array<{ key: string; messages: LogMessage[] }> = [];

  override warn(key: string, ...messages: LogMessage[]): void {
    this.warnings.push({ key, messages });
  }

  /** The `{ error }` payload the warning at `index` carried. */
  reportedError(index: number): unknown {
    return (this.warnings[index].messages[1] as { error: unknown }).error;
  }
}

describe("list-result-container-seed", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let logger: RecordingLogger;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    logger = new RecordingLogger("list-result-container-seed test");
  });

  afterEach(async () => {
    // `closeStorage: false` drains the runtime's outstanding work first,
    // including the background loads a container read starts; closing under
    // them reports each one as a sync failure.
    await runtime?.dispose({ closeStorage: false });
    await storageManager?.close();
  });

  /** A fresh container cell, with no value of its own. */
  function newContainer(cause: string): Cell<any[]> {
    return runtime.getCell<any[]>(space, cause, undefined);
  }

  /** What `container` holds now, read through a transaction of its own. */
  function valueOf(container: Cell<any[]>): unknown {
    const tx = runtime.edit();
    try {
      return container.withTx(tx).getRaw();
    } finally {
      tx.abort("read-only probe");
    }
  }

  /**
   * Make every commit this runtime opens fail with `rejection`, leaving the
   * transaction's reads and writes real and only its outcome injected.
   * `AuthorizationError` without the server's `retriable` marker is a terminal
   * rejection, so `editWithRetry` reports it after a single commit.
   */
  function rejectEveryCommit(rejection: { name: string; message: string }) {
    const openTransaction = runtime.edit.bind(runtime);
    (runtime as any).edit = () => {
      const tx: IExtendedStorageTransaction = openTransaction();
      (tx as any).commit = () => {
        tx.abort(rejection);
        return Promise.resolve({ error: rejection });
      };
      return tx;
    };
  }

  describe("seedResultContainerWhenPullSettles()", () => {
    it("writes an empty array to a container the pull left absent", async () => {
      const container = newContainer("absent-after-pull");
      expect(valueOf(container)).toBeUndefined();
      await seedResultContainerWhenPullSettles(
        runtime,
        () => container,
        Promise.resolve(),
        logger,
      );
      expect(valueOf(container)).toEqual([]);
      expect(logger.warnings).toEqual([]);
    });

    it("leaves a container that arrived during the pull at the value it arrived with", async () => {
      const container = newContainer("arrived-during-pull");
      const pull = Promise.withResolvers<void>();
      const seeded = seedResultContainerWhenPullSettles(
        runtime,
        () => container,
        pull.promise,
        logger,
      );
      const { error } = await runtime.editWithRetry((tx) => {
        container.withTx(tx).set([1, 2, 3]);
      });
      expect(error).toBeUndefined();
      pull.resolve();
      await seeded;
      expect(valueOf(container)).toEqual([1, 2, 3]);
      expect(logger.warnings).toEqual([]);
    });

    it("writes nothing when the coordinator no longer holds the container", async () => {
      const container = newContainer("coordinator-torn-down");
      await seedResultContainerWhenPullSettles(
        runtime,
        () => undefined,
        Promise.resolve(),
        logger,
      );
      expect(valueOf(container)).toBeUndefined();
      expect(logger.warnings).toEqual([]);
    });

    it("seeds after a rejected pull and reports the rejection", async () => {
      const container = newContainer("rejected-pull");
      const pullFailure = new Error("the container pull could not complete");
      // Awaiting proves the returned promise resolves: the coordinator drops
      // it, so a rejection here would surface as an unhandled rejection with
      // nothing left to report it.
      await seedResultContainerWhenPullSettles(
        runtime,
        () => container,
        Promise.reject(pullFailure),
        logger,
      );
      expect(valueOf(container)).toEqual([]);
      expect(logger.warnings.length).toBe(1);
      expect(logger.warnings[0].key).toBe("resume-pull");
      expect(logger.reportedError(0)).toBe(pullFailure);
    });

    it("reports a seed whose commit the storage layer refused", async () => {
      const container = newContainer("refused-seed");
      const rejection = {
        name: "AuthorizationError",
        message: "the space refused the seed",
      };
      rejectEveryCommit(rejection);
      await seedResultContainerWhenPullSettles(
        runtime,
        () => container,
        Promise.resolve(),
        logger,
      );
      expect(valueOf(container)).toBeUndefined();
      expect(logger.warnings.length).toBe(1);
      expect(logger.warnings[0].key).toBe("resume-seed");
      expect(logger.warnings[0].messages[0]).toBe(
        "seeding the empty result container failed",
      );
      expect(logger.reportedError(0)).toBe(rejection);
    });
  });
});
