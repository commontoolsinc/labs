import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { PieceManager } from "@commonfabric/piece";
import { Runtime } from "@commonfabric/runner";
import { loadManager } from "../lib/piece.ts";
import { withEnv } from "./utils.ts";

const AUTO_UPDATE_ENV = "EXPERIMENTAL_SYSTEM_PATTERN_AUTOUPDATE";

describe("CLI runtime creation", () => {
  it("applies deployed-client options to the piece-manager runtime", async () => {
    const identity = await Identity.fromPassphrase(
      "piece runtime creation test",
      { implementation: "noble" },
    );
    const keyPath = await Deno.makeTempFile();
    await Deno.writeFile(keyPath, identity.toPkcs8());
    const originalHealthCheck = Runtime.prototype.healthCheck;
    let created: Runtime | undefined;
    Runtime.prototype.healthCheck = function () {
      created = this;
      return Promise.resolve(false);
    };

    await withEnv(AUTO_UPDATE_ENV, "true", async () => {
      try {
        await expect(loadManager({
          apiUrl: "https://toolshed.test",
          identity: keyPath,
          space: "piece-runtime-creation",
        })).rejects.toThrow("Could not connect");
        expect(created?.apiUrl.href).toBe("https://toolshed.test/");
        expect(created?.experimental.systemPatternAutoUpdate).toBe(true);
      } finally {
        Runtime.prototype.healthCheck = originalHealthCheck;
        await Deno.remove(keyPath);
      }
    });
  });

  it("registers navigation targets through the piece registry", async () => {
    const identity = await Identity.fromPassphrase(
      "piece navigation registration test",
      { implementation: "noble" },
    );
    const keyPath = await Deno.makeTempFile();
    await Deno.writeFile(keyPath, identity.toPkcs8());
    const originalHealthCheck = Runtime.prototype.healthCheck;
    const originalGetSpaceCell = Runtime.prototype.getSpaceCell;
    const originalSynced = PieceManager.prototype.synced;
    let created: Runtime | undefined;
    let manager: PieceManager | undefined;
    Runtime.prototype.healthCheck = function () {
      created = this;
      return Promise.resolve(true);
    };
    Runtime.prototype.getSpaceCell = function (
      this: Runtime,
      ...args: unknown[]
    ) {
      const cell = Reflect.apply(originalGetSpaceCell, this, args);
      Reflect.set(cell, "sync", () => Promise.resolve());
      return cell;
    } as typeof Runtime.prototype.getSpaceCell;
    PieceManager.prototype.synced = () => Promise.resolve();

    try {
      manager = await loadManager({
        apiUrl: "https://toolshed.test",
        identity: keyPath,
        space: "piece-navigation-registration",
      });
      expect(created).toBe(manager.runtime);

      const target = created!.getCell(
        manager.getSpace(),
        "piece-navigation-target",
      );
      let navigationTask: Promise<unknown> | undefined;
      let registryReads = 0;
      let registeredTargets: unknown[] | undefined;
      Reflect.set(created!.storageManager, "synced", () => ({
        then: (onFulfilled: () => unknown) => {
          navigationTask = Promise.resolve().then(onFulfilled);
          return navigationTask;
        },
      }));
      manager.getPieceRegistry = (() => {
        registryReads++;
        return Promise.resolve({
          get: () => [],
        });
      }) as unknown as typeof manager.getPieceRegistry;
      manager.add = ((targets) => {
        registeredTargets = targets;
        return Promise.resolve();
      }) as typeof manager.add;

      created!.navigateCallback!(target);
      expect(navigationTask).toBeDefined();
      await navigationTask;

      expect(registryReads).toBe(1);
      expect(registeredTargets).toEqual([target]);
    } finally {
      Runtime.prototype.healthCheck = originalHealthCheck;
      Runtime.prototype.getSpaceCell = originalGetSpaceCell;
      PieceManager.prototype.synced = originalSynced;
      if (created) {
        await (created.storageManager as unknown as {
          closeNow(): Promise<void>;
        }).closeNow();
        await created.dispose();
      }
      await Deno.remove(keyPath);
    }
  });

  it("authenticates a deferred manager without syncing its space cell", async () => {
    const identity = await Identity.fromPassphrase(
      "piece manager deferred sync test",
      { implementation: "noble" },
    );
    const keyPath = await Deno.makeTempFile();
    await Deno.writeFile(keyPath, identity.toPkcs8());

    const originalHealthCheck = Runtime.prototype.healthCheck;
    const originalGetSpaceCell = Runtime.prototype.getSpaceCell;
    const originalEnsureSpaceSession =
      PieceManager.prototype.ensureSpaceSession;
    const originalManagerSynced = PieceManager.prototype.synced;
    const managers: PieceManager[] = [];
    let spaceCellSyncCalls = 0;
    let spaceSessionCalls = 0;
    let managerSyncCalls = 0;

    Runtime.prototype.healthCheck = () => Promise.resolve(true);
    Runtime.prototype.getSpaceCell = function () {
      return {
        sync: () => {
          spaceCellSyncCalls++;
          return Promise.resolve();
        },
      } as any;
    };
    PieceManager.prototype.synced = () => {
      managerSyncCalls++;
      return Promise.resolve();
    };
    PieceManager.prototype.ensureSpaceSession = () => {
      spaceSessionCalls++;
      return Promise.resolve();
    };

    try {
      managers.push(
        await loadManager({
          apiUrl: "https://toolshed.test",
          identity: keyPath,
          space: "piece-manager-eager-sync",
        }),
      );
      expect(spaceCellSyncCalls).toBe(1);
      expect(spaceSessionCalls).toBe(0);
      expect(managerSyncCalls).toBe(1);

      managers.push(
        await loadManager({
          apiUrl: "https://toolshed.test",
          identity: keyPath,
          space: "piece-manager-deferred-sync",
          deferSpaceCellSync: true,
        }),
      );
      expect(spaceCellSyncCalls).toBe(1);
      expect(spaceSessionCalls).toBe(1);
      expect(managerSyncCalls).toBe(1);
    } finally {
      Runtime.prototype.healthCheck = originalHealthCheck;
      Runtime.prototype.getSpaceCell = originalGetSpaceCell;
      PieceManager.prototype.ensureSpaceSession = originalEnsureSpaceSession;
      PieceManager.prototype.synced = originalManagerSynced;
      for (const manager of managers) {
        await (manager.runtime.storageManager as unknown as {
          closeNow(): Promise<void>;
        }).closeNow();
        await manager.runtime.dispose();
      }
      await Deno.remove(keyPath);
    }
  });
});
