import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { Identity } from "@commonfabric/identity";
import {
  getServerExecutionConfig,
  resolveScopeKey,
  setServerExecutionConfig,
} from "@commonfabric/memory/v2";
import * as Engine from "@commonfabric/memory/v2/engine";

import { SpaceServer } from "../../src/executor/space-server.ts";
import { emptyServingLoopStats } from "../../src/executor/stats.ts";
import { Runtime } from "../../src/runtime.ts";
import { EmulatedStorageManager } from "../../src/storage/v2-emulate.ts";
import { newSharedServer } from "../memory-v2-test-utils.ts";

const owner = await Identity.fromPassphrase("terminal confirmation owner");
const service = await Identity.fromPassphrase("terminal confirmation service");
const space = owner.did();
const ids = [
  "of:confirmation-a",
  "of:confirmation-b",
  "of:confirmation-c",
] as const;

/** Drains transport and scheduler work with positive-delay timers fixed. */
async function settle<T>(work: Promise<T>): Promise<T> {
  await clock.settle();
  return await work;
}

describe("SpaceServer", () => {
  let previous: boolean;
  let server: ReturnType<typeof newSharedServer>;
  let serving: SpaceServer | undefined;

  beforeEach(() => {
    previous = getServerExecutionConfig();
    setServerExecutionConfig(true);
    server = newSharedServer({ subscriptionRefreshDelayMs: "manual" });
  });

  afterEach(async () => {
    try {
      if (serving !== undefined) await settle(serving.park("test-teardown"));
      await settle(server.close());
    } finally {
      serving = undefined;
      setServerExecutionConfig(previous);
    }
  });

  /** Creates a durable owning chain and exposes only its root as demand. */
  async function openFixture(scope: "space" | "user" = "space") {
    const engine = await server.engineForSpace(space);
    const manager = EmulatedStorageManager.connectTo(server, { as: service });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: manager,
      experimental: { serverExecution: true },
      servingPosture: true,
    });
    const scopeKey = resolveScopeKey(scope, { principal: service.did() });
    const commit = Engine.applyCommit(engine, {
      space,
      sessionId: "confirmation-fixture",
      principal: service.did(),
      commitClass: "system",
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: ids.map((id, index) => ({
          op: "set",
          id,
          scope,
          value: {
            value: { plain: 1 },
            ...(index === ids.length - 1 ? {} : {
              result: runtime.getCellFromLink({
                space,
                id: ids[index + 1],
                scope,
                path: [],
              }).getAsWriteRedirectLink(),
            }),
          },
        })),
      },
    });
    expect(commit.revisions).toHaveLength(ids.length);
    let demanded = true;
    let syncs = 0;
    const sync = manager.syncCell.bind(manager);
    manager.syncCell = (cell, options) => {
      syncs++;
      return sync(cell, options);
    };
    const facade = new Proxy(server, {
      get(target, key, receiver) {
        if (key === "demandedInstancesForSpace") {
          return () =>
            demanded ? [{ id: ids[0], scope, scopeKey, root: true }] : [];
        }
        const value = Reflect.get(target, key, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const stats = emptyServingLoopStats();
    serving = new SpaceServer({
      space,
      server: facade,
      engine,
      serviceIdentity: service.did(),
      ensureSpaceRoots: false,
      localSeqRef: { value: 0 },
      stats,
      createRuntime: () =>
        Promise.resolve({
          runtime,
          dispose: async () => {
            await runtime.dispose();
            await manager.close();
          },
        }),
    });
    server.setServerExecutionObserver({
      commitAdmitted: (notice) => serving?.enqueueCommit(notice),
    });
    return {
      manager,
      runtime,
      stats,
      serving,
      syncCount: () => syncs,
      setDemand(value: boolean) {
        demanded = value;
        serving!.noteDemandChanged();
      },
    };
  }

  describe("instance members", () => {
    describe("activate()", () => {
      it("leaves a successor tenure independent of a parked load", async () => {
        const releases = [
          Promise.withResolvers<void>(),
          Promise.withResolvers<void>(),
        ];
        const held = [0, 0];
        const hold = (
          fixture: Awaited<ReturnType<typeof openFixture>>,
          index: number,
        ) => {
          const sync = fixture.manager.syncCell.bind(fixture.manager);
          fixture.manager.syncCell = async (cell, options) => {
            const result = await sync(cell, options);
            if (
              cell.getAsNormalizedFullLink().id === ids[1] && held[index] === 0
            ) {
              held[index]++;
              await releases[index].promise;
            }
            return result;
          };
        };
        const predecessor = await openFixture();
        hold(predecessor, 0);
        try {
          expect(await settle(predecessor.serving.activate())).toBe(true);
          expect(held).toEqual([1, 0]);
          await settle(predecessor.serving.park("new-tenure"));
          const successor = await openFixture();
          hold(successor, 1);
          expect(await settle(successor.serving.activate())).toBe(true);
          expect(held).toEqual([1, 1]);
          releases[0].resolve();
          await clock.settle();
          expect(predecessor.stats.structureLoadTerminal).toBe(0);
          expect(predecessor.stats.structureLoadFailures).toBe(0);
          expect(successor.stats.structureLoadTerminal).toBe(0);
          releases[1].resolve();
          await clock.settle();
          expect(successor.stats.structureLoadTerminal).toBe(1);
          expect(successor.stats.structureLoadFailures).toBe(0);
        } finally {
          for (const release of releases) release.resolve();
        }
      });

      for (const parkDuringLoad of [false, true]) {
        it(`${parkDuringLoad ? "cancels" : "starts"} a resolved piece ${parkDuringLoad ? "after park" : "during its tenure"}`, async () => {
          const fixture = await openFixture();
          const publications: Promise<void>[] = [];
          server.setServerExecutionObserver({
            commitAdmitted: () => publications.push(server.idle()),
          });
          const creatorManager = EmulatedStorageManager.connectTo(server, {
            as: owner,
          });
          const creator = new Runtime({
            apiUrl: new URL(import.meta.url),
            storageManager: creatorManager,
            experimental: { serverExecution: true },
          });
          const release = Promise.withResolvers<void>();
          try {
            const compiled = await creator.patternManager.compilePattern({
              main: "/main.tsx",
              files: [{
                name: "/main.tsx",
                contents:
                  "import { pattern } from 'commonfabric'; export default pattern(() => ({ total: 10 }));",
              }],
            }, { space });
            const root = creator.getCellFromLink({
              space,
              id: ids[2],
              scope: "space",
              path: [],
            });
            await settle(root.sync());
            const tx = creator.edit();
            creator.run(tx, compiled, {}, root);
            expect((await settle(tx.commit())).error).toBeUndefined();
            await settle(creator.storageManager.synced());
            await Promise.all(publications);
            server.setServerExecutionObserver({
              commitAdmitted: (notice) => fixture.serving.enqueueCommit(notice),
            });
            const ref = creator.patternManager.getArtifactEntryRef(compiled)!;
            const load = fixture.runtime.patternManager.loadPatternByIdentity
              .bind(fixture.runtime.patternManager);
            let held = 0;
            fixture.runtime.patternManager.loadPatternByIdentity = async (
              ...args
            ) => {
              const pattern = await load(...args);
              if (args[0] === ref.identity && held === 0) {
                expect(pattern).toBeDefined();
                held++;
                await release.promise;
              }
              return pattern;
            };
            const start = fixture.runtime.start.bind(fixture.runtime);
            let starts = 0;
            fixture.runtime.start = async (cell) => {
              starts++;
              return await start(cell);
            };
            expect(await settle(fixture.serving.activate())).toBe(true);
            expect(held).toBe(1);
            expect(starts).toBe(0);
            if (parkDuringLoad) {
              await settle(fixture.serving.park("pattern-resolution"));
            }
            release.resolve();
            await clock.settle();
            expect(starts).toBe(parkDuringLoad ? 0 : 1);
            const servingRoot = fixture.runtime.getCellFromLink({
              space,
              id: ids[2],
              scope: "space",
              path: [],
            });
            expect(fixture.runtime.runner.pieceGraphIsInstalled(servingRoot))
              .toBe(!parkDuringLoad);
            expect(fixture.stats.structureLoadFailures).toBe(0);
          } finally {
            release.resolve();
            await settle(creator.dispose());
            await settle(creatorManager.close());
          }
        });
      }

      for (const scope of ["space", "user"] as const) {
        it(`confirms a cold ${scope} chain using only its traversed addresses`, async () => {
          const fixture = await openFixture(scope);
          expect(await settle(fixture.serving.activate())).toBe(true);
          expect(fixture.stats.structureLoadTerminal).toBe(1);
          expect(fixture.syncCount()).toBe(scope === "space" ? 6 : 8);
          expect(server.demandSetSizesForSpace(space).perSession).toMatchObject(
            [
              {
                tracked: scope === "space" ? 3 : 4,
                watches: scope === "space" ? 3 : 4,
              },
            ],
          );

          const syncs = fixture.syncCount();
          await settle(
            server.writeDocument(space, "of:confirmation-unrelated", {
              plain: 2,
            }),
          );
          expect(fixture.syncCount()).toBe(syncs);
          expect(fixture.stats.structureLoadTerminal).toBe(1);
          expect(fixture.stats.structureLoadRearmed).toBe(0);
        });
      }

      it("confirms again when a departed demand returns", async () => {
        const fixture = await openFixture();
        expect(await settle(fixture.serving.activate())).toBe(true);
        expect(fixture.stats.structureLoadTerminal).toBe(1);
        fixture.setDemand(false);
        await clock.tick(300);
        await clock.settle();
        expect(fixture.stats.demand.demandedInstances).toBe(0);
        fixture.setDemand(true);
        await clock.tick(300);
        await clock.settle();
        expect(fixture.stats.structureLoadTerminal).toBe(2);
        expect(fixture.syncCount()).toBe(12);
      });

      it("retires a decision when demand leaves during confirmation", async () => {
        const fixture = await openFixture();
        const release = Promise.withResolvers<void>();
        const sync = fixture.manager.syncCell.bind(fixture.manager);
        let reads = 0;
        let held = 0;
        fixture.manager.syncCell = async (cell, options) => {
          const result = await sync(cell, options);
          if (
            cell.getAsNormalizedFullLink().id === ids[1] &&
            cell.tx?.tx.immediate && ++reads === 2
          ) {
            held++;
            await release.promise;
          }
          return result;
        };
        try {
          expect(await settle(fixture.serving.activate())).toBe(true);
          expect(held).toBe(1);
          fixture.setDemand(false);
          release.resolve();
          await clock.settle();
          expect(fixture.stats.demand.demandedInstances).toBe(0);
          const decisions = fixture.stats.structureLoadTerminal;
          fixture.setDemand(true);
          await clock.tick(300);
          await clock.settle();
          expect(fixture.stats.structureLoadTerminal).toBe(decisions + 1);
          expect(fixture.syncCount()).toBe(12);
        } finally {
          release.resolve();
        }
      });

      for (const pass of [1, 2]) {
        it(`retries a failed chain sync in traversal ${pass} without terminalizing`, async () => {
          const fixture = await openFixture();
          const sync = fixture.manager.syncCell.bind(fixture.manager);
          let matching = 0;
          let failing = true;
          fixture.manager.syncCell = async (cell, options) => {
            if (
              cell.getAsNormalizedFullLink().id === ids[1] &&
              cell.tx?.tx.immediate &&
              ++matching >= pass && failing
            ) {
              throw new Error("injected chain sync failure");
            }
            return await sync(cell, options);
          };
          expect(await settle(fixture.serving.activate())).toBe(true);
          const failures = fixture.stats.structureLoadFailures;
          expect(failures).toBeGreaterThan(0);
          expect(fixture.stats.structureLoadTerminal).toBe(0);
          failing = false;
          await settle(
            server.writeDocument(space, "of:confirmation-retry", { plain: 2 }),
          );
          expect(fixture.stats.structureLoadTerminal).toBe(1);
          expect(fixture.stats.structureLoadFailures).toBe(failures);
        });

        for (const failure of [false, true]) {
          it(`discards traversal ${pass} ${failure ? "failure" : "success"} after tenure ends`, async () => {
            const fixture = await openFixture();
            const release = Promise.withResolvers<void>();
            const sync = fixture.manager.syncCell.bind(fixture.manager);
            let matching = 0;
            let held = 0;
            fixture.manager.syncCell = async (cell, options) => {
              const result = await sync(cell, options);
              if (
                cell.getAsNormalizedFullLink().id === ids[1] &&
                cell.tx?.tx.immediate &&
                ++matching === pass
              ) {
                held++;
                await release.promise;
                if (failure) {
                  throw new Error("injected late chain sync failure");
                }
              }
              return result;
            };
            try {
              expect(await settle(fixture.serving.activate())).toBe(true);
              expect(held).toBe(1);
              const parked = fixture.serving.park("confirmation-test");
              await clock.settle();
              release.resolve();
              await settle(parked);
              expect(fixture.stats.structureLoadTerminal).toBe(0);
              expect(fixture.stats.structureLoadFailures).toBe(0);
              expect(fixture.stats.structureLoadDeferred).toBe(0);
            } finally {
              release.resolve();
            }
          });
        }
      }
    });
  });
});
