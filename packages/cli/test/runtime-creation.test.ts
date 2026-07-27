import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { createSession, Identity } from "@commonfabric/identity";
import { Runtime } from "@commonfabric/runner";
import { PieceManager } from "@commonfabric/piece";
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
});
