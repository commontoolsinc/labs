import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Runtime } from "@commontools/runner";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { createSession, Identity } from "@commontools/identity";
import { PieceManager } from "../src/manager.ts";
import { PiecesController } from "../src/ops/pieces-controller.ts";

const signer = await Identity.fromPassphrase("test default pattern");

describe("PiecesController.ensureDefaultPattern", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let manager: PieceManager;
  let controller: PiecesController;

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
    manager = new PieceManager(session, runtime);
    await manager.synced();
    controller = new PiecesController(manager);
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

    // Create a mock piece cell
    const mockPieceCell = runtime.getImmutableCell(
      manager.getSpace(),
      { name: "MockDefaultPattern" },
    );

    // Link it as the default pattern
    await manager.linkDefaultPattern(mockPieceCell);

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

  describe("initial state", () => {
    it("should have no defaultPattern in space cell initially", () => {
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

  describe("linkDefaultPattern idempotence", () => {
    it("should succeed when linking the same pattern twice", async () => {
      // Create a mock piece cell
      const mockPieceCell = runtime.getImmutableCell(
        manager.getSpace(),
        { name: "MockDefaultPattern" },
      );

      // Link it as the default pattern
      await manager.linkDefaultPattern(mockPieceCell);

      // Link the same pattern again - should be idempotent (no error)
      await manager.linkDefaultPattern(mockPieceCell);

      // Verify the pattern is still linked correctly by checking space cell
      const spaceCell = runtime.getCell(
        manager.getSpace(),
        manager.getSpace(),
      );
      const defaultPatternCell = spaceCell.key("defaultPattern");
      const value = defaultPatternCell.get();
      expect(value).toBeDefined();
    });

    it("should replace existing pattern when linking a different one", async () => {
      // Create first mock piece cell
      const mockPieceCell1 = runtime.getImmutableCell(
        manager.getSpace(),
        { name: "MockDefaultPattern1" },
      );

      // Create second mock piece cell
      const mockPieceCell2 = runtime.getImmutableCell(
        manager.getSpace(),
        { name: "MockDefaultPattern2" },
      );

      // Link first pattern
      await manager.linkDefaultPattern(mockPieceCell1);

      // Capture first link by serializing
      const spaceCell = runtime.getCell(
        manager.getSpace(),
        manager.getSpace(),
      );
      const defaultPatternCell = spaceCell.key("defaultPattern");
      const firstValue = defaultPatternCell.get();
      expect(firstValue).toBeDefined();
      const firstJson = JSON.stringify(firstValue);

      // Link second pattern (replacing first)
      await manager.linkDefaultPattern(mockPieceCell2);

      // Verify second pattern is now linked
      const secondValue = defaultPatternCell.get();
      expect(secondValue).toBeDefined();
      const secondJson = JSON.stringify(secondValue);

      // The links should be different (different patterns)
      expect(firstJson).not.toEqual(secondJson);
    });
  });
});

describe("PiecesController.recreateDefaultPattern", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let manager: PieceManager;
  let controller: PiecesController;

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
    manager = new PieceManager(session, runtime);
    await manager.synced();
    controller = new PiecesController(manager);
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
    await expect(controller.recreateDefaultPattern()).rejects.toThrow();
  });

  it("should handle disposed controller gracefully", async () => {
    await controller.dispose();

    await expect(controller.recreateDefaultPattern()).rejects.toThrow(
      /disposed/,
    );
  });

  it("should unlink existing defaultPattern before creating new one", async () => {
    // Create a mock piece cell and link it as the default pattern
    const mockPieceCell = runtime.getImmutableCell(
      manager.getSpace(),
      { name: "MockDefaultPattern" },
    );
    await manager.linkDefaultPattern(mockPieceCell);

    // Verify it's linked by checking the space cell directly
    const spaceCell = runtime.getCell(
      manager.getSpace(),
      manager.getSpace(),
    );
    const defaultPatternCell = spaceCell.key("defaultPattern");
    expect(defaultPatternCell.get()).toBeDefined();

    // recreateDefaultPattern will fail (no server) but should unlink first
    await expect(controller.recreateDefaultPattern()).rejects.toThrow();

    // Pattern should be unlinked now (unlink happens before the network call)
    // After unlinking, the cell value is set to undefined
    const afterValue = defaultPatternCell.get();
    expect(afterValue).toBeUndefined();
  });

  it("should work even when no defaultPattern exists initially", async () => {
    // Verify no pattern exists by checking the space cell directly
    const spaceCell = runtime.getCell(
      manager.getSpace(),
      manager.getSpace(),
    );
    const defaultPatternCell = spaceCell.key("defaultPattern");
    expect(defaultPatternCell.get()?.get()).toBeUndefined();

    // Should still attempt to create (and fail due to fake server)
    await expect(controller.recreateDefaultPattern()).rejects.toThrow();
  });
});
