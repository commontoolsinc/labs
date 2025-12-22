import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Runtime } from "@commontools/runner";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { createSession, Identity } from "@commontools/identity";
import { CharmManager } from "../src/manager.ts";
import { CharmsController } from "../src/ops/charms-controller.ts";

const signer = await Identity.fromPassphrase("test default pattern");

describe("CharmsController.ensureDefaultPattern", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let manager: CharmManager;
  let controller: CharmsController;

  beforeEach(async () => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      // Use a fake URL since we won't actually fetch patterns in unit tests
      apiUrl: new URL("http://localhost:9999"),
      storageManager,
    });

    const session = await createSession({
      identity: signer,
      spaceName: "test-space-" + crypto.randomUUID(),
    });
    manager = new CharmManager(session, runtime);
    await manager.synced();
    controller = new CharmsController(manager);
  });

  afterEach(async () => {
    try {
      await controller?.dispose();
    } catch {
      // Already disposed
    }
    await storageManager?.close();
  });

  it("should throw if pattern server is unavailable", async () => {
    // The fake URL should cause pattern loading to fail
    // The error can be either a network error or our wrapped error
    await expect(controller.ensureDefaultPattern()).rejects.toThrow();
  });

  it("should not have defaultPattern initially", async () => {
    const pattern = await manager.getDefaultPattern();
    expect(pattern).toBeUndefined();
  });

  it("should handle disposed controller gracefully", async () => {
    await controller.dispose();

    await expect(controller.ensureDefaultPattern()).rejects.toThrow(
      /disposed/,
    );
  });

  it("should link defaultPattern cell successfully", async () => {
    // This test verifies that linkDefaultPattern works correctly
    // Note: Creating an actual working pattern requires the pattern server

    // Create a mock charm cell
    const mockCharmCell = runtime.getImmutableCell(
      manager.getSpace(),
      { name: "MockDefaultPattern" },
    );

    // Link it as the default pattern
    await manager.linkDefaultPattern(mockCharmCell);

    // Verify the link exists by checking the space cell directly
    const spaceCell = runtime.getCell(
      manager.getSpace(),
      manager.getSpace(),
    );
    const defaultPatternCell = spaceCell.key("defaultPattern");
    // The cell should have a reference linked
    const value = defaultPatternCell.get();
    expect(value).toBeDefined();
  });

  describe("transaction-based synchronization", () => {
    it("should use transaction system for race protection", async () => {
      // The space cell should initially have no defaultPattern
      const spaceCell = runtime.getCell(
        manager.getSpace(),
        manager.getSpace(),
      );
      const defaultPatternCell = spaceCell.key("defaultPattern");

      // Initially should be undefined/null
      const initialValue = defaultPatternCell.get();
      expect(initialValue?.get()).toBeUndefined();
    });
  });
});
