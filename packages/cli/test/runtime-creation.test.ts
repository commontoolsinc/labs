import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { createSession, Identity } from "@commonfabric/identity";
import { PieceManager } from "@commonfabric/piece";
import { Runtime } from "@commonfabric/runner";
import { createRuntime as createAclRuntime } from "../lib/acl.ts";
import { loadManager } from "../lib/piece.ts";
import { withEnv } from "./utils.ts";

const AUTO_UPDATE_ENV = "EXPERIMENTAL_SYSTEM_PATTERN_AUTOUPDATE";

describe("CLI runtime creation", () => {
  it("applies deployed-client options to the ACL runtime", async () => {
    const identity = await Identity.fromPassphrase("acl runtime creation test");
    const session = await createSession({
      identity,
      spaceName: "acl-runtime-creation",
    });
    const originalHealthCheck = Runtime.prototype.healthCheck;
    let created: Runtime | undefined;
    Runtime.prototype.healthCheck = function () {
      created = this;
      return Promise.resolve(false);
    };

    await withEnv(AUTO_UPDATE_ENV, "true", async () => {
      try {
        await expect(createAclRuntime({
          apiUrl: new URL("https://toolshed.test"),
          identityPath: "unused",
          space: "unused",
        }, session)).rejects.toThrow("Could not connect");
        expect(created?.apiUrl.href).toBe("https://toolshed.test/");
        expect(created?.experimental.systemPatternAutoUpdate).toBe(true);
      } finally {
        Runtime.prototype.healthCheck = originalHealthCheck;
        if (created) {
          await (created.storageManager as unknown as {
            closeNow(): Promise<void>;
          }).closeNow();
          await created.dispose();
        }
      }
    });
  });

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

  it("defers both space-cell and manager sync when requested", async () => {
    const identity = await Identity.fromPassphrase(
      "piece manager deferred sync test",
      { implementation: "noble" },
    );
    const keyPath = await Deno.makeTempFile();
    await Deno.writeFile(keyPath, identity.toPkcs8());

    const originalHealthCheck = Runtime.prototype.healthCheck;
    const originalGetSpaceCell = Runtime.prototype.getSpaceCell;
    const originalManagerSynced = PieceManager.prototype.synced;
    const managers: PieceManager[] = [];
    let spaceCellSyncCalls = 0;
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

    try {
      managers.push(
        await loadManager({
          apiUrl: "https://toolshed.test",
          identity: keyPath,
          space: "piece-manager-eager-sync",
        }),
      );
      expect(spaceCellSyncCalls).toBe(1);
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
      expect(managerSyncCalls).toBe(1);
    } finally {
      Runtime.prototype.healthCheck = originalHealthCheck;
      Runtime.prototype.getSpaceCell = originalGetSpaceCell;
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
