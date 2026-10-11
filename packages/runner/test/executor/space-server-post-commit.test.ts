import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import * as Engine from "@commonfabric/memory/v2/engine";
import { defer } from "@commonfabric/utils/defer";

import { SpaceServer } from "../../src/executor/space-server.ts";
import { emptyServingLoopStats } from "../../src/executor/stats.ts";
import {
  stampWaveRunContext,
  waveSettlementOf,
} from "../../src/executor/wave.ts";
import { Runtime } from "../../src/runtime.ts";
import type { MemorySpace } from "../../src/storage/interface.ts";
import { EmulatedStorageManager } from "../../src/storage/v2-emulate.ts";
import { newSharedServer } from "../memory-v2-test-utils.ts";

const spaceSigner = await Identity.fromPassphrase("post-commit space");
const serviceSigner = await Identity.fromPassphrase("post-commit service");
const space = spaceSigner.did() as MemorySpace;

describe("SpaceServer", () => {
  describe("instance members", () => {
    describe("activate()", () => {
      it("commits the next wave while the previous wave's view-plan publish is still in flight", async () => {
        const server = newSharedServer({ subscriptionRefreshDelayMs: 0 });
        const engine = await server.engineForSpace(space);
        const manager = EmulatedStorageManager.connectTo(server, {
          as: serviceSigner,
        });
        const runtime = new Runtime({
          apiUrl: new URL(import.meta.url),
          storageManager: manager,
          servingPosture: true,
          experimental: { serverExecution: true },
        });
        // The first publish's read of the view interests parks on `gate`
        // once it has entered; the publish, and everything queued behind
        // it, waits there until the test releases it.
        const entered = defer<void>();
        const gate = defer<void>();
        let publishes = 0;
        const facade = new Proxy(server, {
          get(target, property, receiver) {
            if (property === "viewInterestsForSpace") {
              return async (
                ...args: Parameters<typeof server.viewInterestsForSpace>
              ) => {
                if (++publishes === 1) {
                  entered.resolve();
                  await gate.promise;
                }
                return target.viewInterestsForSpace(...args);
              };
            }
            const value = Reflect.get(target, property, receiver);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
        const serving = new SpaceServer({
          space,
          engine,
          server: facade,
          serviceIdentity: serviceSigner.did(),
          createRuntime: () =>
            Promise.resolve({ runtime, dispose: () => runtime.dispose() }),
          localSeqRef: { value: 0 },
          stats: emptyServingLoopStats(),
          policy: { flushDeadlineMs: 2_000, idleParkMs: 600_000 },
        });
        const commit = async (value: number) => {
          const probe = runtime.getCell<number>(space, "work", undefined);
          await probe.sync();
          const tx = runtime.edit();
          stampWaveRunContext(tx, { actionId: "work", kind: "derivation" });
          probe.withTx(tx).set(value);
          expect((await tx.commit().settled).error).toBeUndefined();
          expect((await waveSettlementOf(tx))?.error).toBeUndefined();
          return Engine.read(engine, { id: probe.getAsNormalizedFullLink().id })
            ?.value;
        };
        try {
          expect(await serving.activate()).toBe(true);
          expect(await commit(1)).toBe(1);
          await entered.promise;

          expect(await commit(2)).toBe(2);

          expect(publishes).toBe(1);
          gate.resolve();
        } finally {
          gate.resolve();
          try {
            await serving.park("test-teardown");
          } finally {
            await server.close();
          }
        }
      });
    });
  });
});
