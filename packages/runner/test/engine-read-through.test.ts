/**
 * Drives the serving loop end to end under `SpaceServerPolicy.storeReadThrough`
 * — a real memory server, its engine, a client runtime committing over the
 * loopback wire, and the SpaceServer's serving runtime — and checks that the
 * serving runtime reads its home space from the engine: it registers no
 * session watch, it derives from documents it read on first access, and an
 * authored commit landing after its reads reaches it through the feed's
 * refresh rather than through a frame. The posture off is the control.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";
import * as Engine from "@commonfabric/memory/v2/engine";
import type { Cell } from "../src/cell.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import type { Options } from "../src/storage/v2.ts";
import { Runtime } from "../src/runtime.ts";
import type { MemorySpace } from "../src/storage/interface.ts";
import { engineReadThrough } from "../src/executor/engine-read-through.ts";
import { ExecutorHost } from "../src/executor/host.ts";
import type { SpaceServerPolicy } from "../src/executor/space-server.ts";
import { readWatermarkSeq, waitForSettled } from "../src/executor/watermark.ts";
import { TEST_MEMORY_SERVER_AUTH } from "./memory-v2-test-utils.ts";
import { waitUntil } from "./support/wait-until.ts";

class SharedServerStorageManager extends EmulatedStorageManager {
  /**
   * Delegates to the base `connectTo()`: `new this` gives back this subclass,
   * and the base clears server ownership so closing this manager never closes
   * the shared server.
   */
  static override connectTo(
    server: MemoryV2Server.Server,
    options: Omit<Options, "memoryHost" | "spaceHostMap">,
  ): SharedServerStorageManager {
    return super.connectTo(server, options) as SharedServerStorageManager;
  }
}

const spaceSigner = await Identity.fromPassphrase("read-through space");
const space = spaceSigner.did() as MemorySpace;
const serviceSigner = await Identity.fromPassphrase("read-through service");
const aliceSigner = await Identity.fromPassphrase("read-through alice");

describe("engine-read-through", () => {
  let server: MemoryV2Server.Server;
  let host: ExecutorHost | undefined;
  let clientManager: SharedServerStorageManager;
  let clientRuntime: Runtime;

  const newHost = (policy: SpaceServerPolicy): ExecutorHost =>
    new ExecutorHost({
      server,
      serviceIdentity: serviceSigner.did(),
      createRuntime: async () => {
        const manager = SharedServerStorageManager.connectTo(server, {
          as: serviceSigner,
        });
        const runtime = new Runtime({
          apiUrl: new URL(import.meta.url),
          storageManager: manager,
          servingPosture: true,
          experimental: { serverExecution: true },
        });
        // The pattern run below stands in for the structure loads the
        // SpaceServer performs after activation, which see the read-through
        // the SpaceServer installs; the factory installs the same one ahead
        // of the run so the stand-in reads the way those loads do.
        if (policy.storeReadThrough === true) {
          manager.installStoreReadThrough(
            space,
            engineReadThrough(await server.engineForSpace(space)),
          );
        }
        await runServingPattern(runtime);
        return {
          runtime,
          dispose: async () => {
            await runtime.dispose();
            await manager.close();
          },
        };
      },
      policy,
    });

  /**
   * The serving graph: a pattern deriving `total = n + 1`, run server-side
   * at activation the way the demand loader materializes structure. The
   * run races the client's in-flight authored writes, so a stale-read
   * conflict is retried the way the loader's own presync does.
   */
  const runServingPattern = async (runtime: Runtime): Promise<void> => {
    const compiled = await runtime.patternManager.compilePattern({
      main: "/main.tsx",
      files: [{
        name: "/main.tsx",
        contents: [
          "import { computed, pattern } from 'commonfabric';",
          "export default pattern<{ n: number }, { total: number }>(",
          "  ({ n }) => ({ total: computed(() => n + 1) }),",
          ");",
        ].join("\n"),
      }],
    }, { space });
    const argument = runtime.getCell<{ n: number }>(
      space,
      "read-through-arg",
      undefined,
    );
    const result = runtime.getCell<{ total: number }>(
      space,
      "read-through-result",
      compiled.resultSchema,
    );
    for (let attempt = 0;; attempt++) {
      await argument.sync();
      await result.sync();
      const tx = runtime.edit();
      runtime.run(tx, compiled, argument, result);
      const committed = await tx.commit();
      if (committed.error === undefined) break;
      if (attempt >= 4) {
        throw new Error(
          `serving pattern run failed: ${committed.error.message}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await runtime.idle();
  };

  /** The service principal's live sessions on the space. */
  const serviceSessions = () =>
    server.accessForTestingOnly.sessionsForSpace(space).filter((session) =>
      session.principal === serviceSigner.did()
    );

  /** Commits `n` from the client and waits for the serving loop's derived
   * `total` to reach the client's subscription. */
  const deriveFromClient = async (
    clientArg: Cell<{ n: number }>,
    clientResult: Cell<{ total: number }>,
    n: number,
  ): Promise<void> => {
    const engine = await server.engineForSpace(space);
    const tx = clientRuntime.edit();
    clientArg.withTx(tx).set({ n });
    expect((await tx.commit()).error).toBeUndefined();
    const authoredSeq = Engine.serverSeq(engine);
    await waitUntil(
      () => readWatermarkSeq(engine) >= authoredSeq,
      "watermark to reach the authored commit",
    );
    const settled = await waitForSettled(clientRuntime, space, authoredSeq, {
      timeoutMs: 10_000,
    });
    expect(settled).toBeGreaterThanOrEqual(authoredSeq);
    await waitUntil(
      () => clientResult.key("total").get() === n + 1,
      `client to observe the derived value ${n + 1}`,
    );
  };

  beforeEach(() => {
    server = new MemoryV2Server.Server({
      subscriptionRefreshDelayMs: 0,
      authorizeSessionOpen(message) {
        const principal = (message.authorization as { principal?: unknown })
          ?.principal;
        return typeof principal === "string" ? principal : undefined;
      },
      sessionOpenAuth: TEST_MEMORY_SERVER_AUTH.sessionOpenAuth,
    });
    clientManager = SharedServerStorageManager.connectTo(server, {
      as: aliceSigner,
    });
    clientRuntime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: clientManager,
    });
  });

  afterEach(async () => {
    await host?.close();
    host = undefined;
    await clientRuntime.dispose();
    await clientManager.close();
    await server.close();
  });

  it("derives from engine reads with no session watch, and refreshes a held document from the feed when a later authored commit writes it", async () => {
    host = newHost({
      flushDeadlineMs: 5_000,
      idleParkMs: 600_000,
      storeReadThrough: true,
    });
    const clientResult = clientRuntime.getCell<{ total: number }>(
      space,
      "read-through-result",
      undefined,
    );
    await clientResult.sync();
    const clientArg = clientRuntime.getCell<{ n: number }>(
      space,
      "read-through-arg",
      undefined,
    );
    await clientArg.sync();

    await deriveFromClient(clientArg, clientResult, 41);
    expect(host.spaceServer(space)?.active).toBe(true);
    expect(serviceSessions().length).toBeGreaterThan(0);
    for (const session of serviceSessions()) {
      expect(session.watches).toEqual([]);
    }
    const readsAfterFirst = host.stats().storeReads;
    expect(readsAfterFirst).toBeGreaterThan(0);

    // The second write lands after the serving runtime read the argument
    // document; with no watch on it, only the feed refresh can move it.
    await deriveFromClient(clientArg, clientResult, 100);
    expect(host.stats().storeRefreshes).toBeGreaterThan(0);
    expect(host.stats().storeReads).toBeGreaterThan(readsAfterFirst);
    for (const session of serviceSessions()) {
      expect(session.watches).toEqual([]);
    }
  });

  it("registers session watches and performs no engine reads with the posture off", async () => {
    host = newHost({ flushDeadlineMs: 5_000, idleParkMs: 600_000 });
    const clientResult = clientRuntime.getCell<{ total: number }>(
      space,
      "read-through-result",
      undefined,
    );
    await clientResult.sync();
    const clientArg = clientRuntime.getCell<{ n: number }>(
      space,
      "read-through-arg",
      undefined,
    );
    await clientArg.sync();

    await deriveFromClient(clientArg, clientResult, 41);
    expect(serviceSessions().some((session) => session.watches.length > 0))
      .toBe(true);
    expect(host.stats().storeReads).toBe(0);
    expect(host.stats().storeRefreshes).toBe(0);
  });
});
