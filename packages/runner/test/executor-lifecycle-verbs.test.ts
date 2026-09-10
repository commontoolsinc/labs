// The serving loop's lifecycle-verb queue (docs/features/
// server-pattern-lifecycle.md): a verb handed to the host runs on the
// space's serving runtime as a step of a wave cycle and settles once that
// cycle's wave has committed, so what the verb wrote is durable by the
// time its receipt is in hand.

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { Runtime } from "../src/runtime.ts";
import type { MemorySpace } from "../src/storage/interface.ts";
import { ExecutorHost } from "../src/executor/host.ts";
import {
  LIFECYCLE_VERB_SPACE_PARKED,
  SpaceServer,
} from "../src/executor/space-server.ts";
import {
  emptyServingLoopStats,
  type ServingLoopStats,
} from "../src/executor/stats.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

const spaceSigner = await Identity.fromPassphrase("lifecycle verbs space");
const space = spaceSigner.did() as MemorySpace;
const serviceSigner = await Identity.fromPassphrase("lifecycle verbs service");
const aliceSigner = await Identity.fromPassphrase("lifecycle verbs alice");

const MARKER_CAUSE = "lifecycle-verb-marker";

describe("ExecutorHost.runLifecycleVerb", () => {
  let server: MemoryV2Server.Server;
  let host: ExecutorHost | undefined;
  let cleanups: Array<() => Promise<void>>;

  const servingRuntime = () => {
    const manager = EmulatedStorageManager.connectTo(server, {
      as: serviceSigner,
    });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: manager,
      servingPosture: true,
      experimental: { serverExecution: true },
    });
    return Promise.resolve({
      runtime,
      dispose: async () => {
        await runtime.dispose();
        await manager.close();
      },
    });
  };

  const newHost = (): ExecutorHost =>
    new ExecutorHost({
      server,
      serviceIdentity: serviceSigner.did(),
      createRuntime: servingRuntime,
      policy: { flushDeadlineMs: 5_000, idleParkMs: 600_000 },
    });

  const clientRuntime = (): Runtime => {
    const manager = EmulatedStorageManager.connectTo(server, {
      as: aliceSigner,
    });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: manager,
      experimental: { serverExecution: true },
    });
    cleanups.push(async () => {
      await runtime.dispose();
      await manager.close();
    });
    return runtime;
  };

  /** A verb whose one write is a marker document, stamped as the loop's
   * own bookkeeping the way every served verb's writes are. */
  const writeMarker = (runtime: Runtime, marker: string) =>
    runtime.editWithRetry((tx) => {
      runtime.stampServerRun(tx, {
        actionId: `test-verb/${marker}`,
        kind: "bookkeeping",
      });
      runtime.getCell<{ marker: string }>(space, MARKER_CAUSE, undefined)
        .withTx(tx).set({ marker });
    });

  beforeEach(() => {
    server = newSharedServer({ subscriptionRefreshDelayMs: 0 });
    cleanups = [];
  });

  afterEach(async () => {
    await host?.close();
    host = undefined;
    for (const cleanup of cleanups.reverse()) await cleanup();
    await server.close();
  });

  it("activates a space nobody holds a session on, runs the verb, and resolves once its write is durable", async () => {
    host = newHost();
    const receipt = await host.runLifecycleVerb(space, {
      name: "mark",
      run: async (runtime) => {
        const outcome = await writeMarker(runtime, "served");
        expect(outcome.error).toBeUndefined();
        return "marked";
      },
    });
    expect(receipt).toBe("marked");
    expect(host.spaceServer(space)?.active).toBe(true);

    // A reader that opens its session only now sees the write: the
    // receipt came after the wave commit, not after the seal.
    const reader = clientRuntime();
    const cell = reader.getCell<{ marker: string }>(
      space,
      MARKER_CAUSE,
      undefined,
    );
    await cell.sync();
    expect(cell.get()).toEqual({ marker: "served" });
    expect(host.stats().lifecycleVerbs).toEqual({ runs: 1, failures: 0 });
  });

  it("derives a piece the verb stages before the receipt returns, when the verb names the piece as its demand root", async () => {
    host = newHost();
    const PATTERN = [
      "import { computed, pattern } from 'commonfabric';",
      "export default pattern<{ n: number }, { total: number }>(",
      "  ({ n }) => ({ total: computed(() => n * 7) }),",
      ");",
    ].join("\n");
    const receipt = await host.runLifecycleVerb(space, {
      name: "instantiate",
      run: async (runtime) => {
        const pattern = await runtime.patternManager.compilePattern({
          main: "/main.tsx",
          files: [{ name: "/main.tsx", contents: PATTERN }],
        }, { space });
        const piece = runtime.getCell<{ total: number }>(
          space,
          "verb-staged-piece",
          pattern.resultSchema,
        );
        const outcome = await runtime.editWithRetry((tx) => {
          runtime.stampServerRun(tx, {
            actionId: "test-verb/instantiate",
            kind: "bookkeeping",
          });
          void runtime.setup(tx, pattern, { n: 6 }, piece, {
            initializePieceSourceHistory: true,
          });
        });
        expect(outcome.error).toBeUndefined();
        return {
          rootId: piece.getAsNormalizedFullLink().id,
          resultSchema: pattern.resultSchema,
        };
      },
      demandRoots: (receipt) => [receipt.rootId],
    });
    expect(receipt.rootId).toMatch(/^of:/);

    // A reader opening its session only now, under the result schema so
    // the read reaches the computed's own document: the receipt came after
    // the wave that derived the piece, so the value is in the store.
    const reader = clientRuntime();
    const cell = reader.getCell<{ total: number }>(
      space,
      "verb-staged-piece",
      receipt.resultSchema,
    );
    await cell.sync();
    expect(cell.key("total").get()).toBe(42);
  });

  it("rejects with the verb's own error and counts the failure", async () => {
    host = newHost();
    await expect(host.runLifecycleVerb(space, {
      name: "explode",
      run: () => Promise.reject(new Error("the verb refused")),
    })).rejects.toThrow("the verb refused");
    expect(host.stats().lifecycleVerbs).toEqual({ runs: 1, failures: 1 });
    // The tenure survives a failed verb: the next one runs.
    const receipt = await host.runLifecycleVerb(space, {
      name: "mark",
      run: async (runtime) => {
        await writeMarker(runtime, "after-failure");
        return "ok";
      },
    });
    expect(receipt).toBe("ok");
  });

  it("rejects when the durability read refuses, after the verb itself ran", async () => {
    host = newHost();
    let ran = false;
    await expect(host.runLifecycleVerb(space, {
      name: "unconfirmable",
      run: () => {
        ran = true;
        return Promise.resolve("receipt");
      },
      confirm: () => Promise.reject(new Error("nothing durable")),
    })).rejects.toThrow("nothing durable");
    expect(ran).toBe(true);
    expect(host.stats().lifecycleVerbs).toEqual({ runs: 1, failures: 1 });
  });

  it("runs queued verbs in arrival order, each awaited before the next", async () => {
    host = newHost();
    const order: string[] = [];
    const verb = (name: string) =>
      host!.runLifecycleVerb(space, {
        name,
        run: async (runtime) => {
          order.push(`${name}:start`);
          await writeMarker(runtime, name);
          order.push(`${name}:end`);
          return name;
        },
      });
    const receipts = await Promise.all([verb("first"), verb("second")]);
    expect(receipts).toEqual(["first", "second"]);
    expect(order).toEqual([
      "first:start",
      "first:end",
      "second:start",
      "second:end",
    ]);
  });

  it("a SpaceServer that is not active refuses a verb with the parked message", async () => {
    const stats: ServingLoopStats = emptyServingLoopStats();
    const engine = await server.engineForSpace(space);
    const inactive = new SpaceServer({
      space,
      server,
      engine,
      serviceIdentity: serviceSigner.did(),
      createRuntime: servingRuntime,
      localSeqRef: { value: 0 },
      stats,
    });
    await expect(inactive.runLifecycleVerb({
      name: "never",
      run: () => Promise.resolve(undefined),
    })).rejects.toThrow(LIFECYCLE_VERB_SPACE_PARKED);
  });
});
