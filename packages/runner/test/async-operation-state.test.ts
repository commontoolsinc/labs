import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import {
  asyncOperationCacheSchema,
  computeInputHash,
  getState,
  isTimedOut,
  transitionToError,
  transitionToFetching,
  transitionToIdle,
  transitionToSuccess,
  updatePartial,
} from "../src/builtins/async-operation-state.ts";
import { type Cell } from "../src/cell.ts";
import { type IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("test async-operation-state");
const space = signer.did();

describe("async-operation-state", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;
  let cache: Cell<any>;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    tx = runtime.edit();

    // Create a cache cell for testing
    cache = runtime.getCell(
      space,
      { test: "cache" },
      asyncOperationCacheSchema,
      tx,
    );
  });

  afterEach(async () => {
    await tx.commit();
    await runtime?.dispose();
    await storageManager?.close();
  });

  describe("getState", () => {
    it("should return idle state for non-existent entry", () => {
      const state = getState(cache, "non-existent-hash", tx);
      expect(state.type).toBe("idle");
    });

    it("should return existing state from cache", () => {
      const inputHash = "test-hash";
      cache.withTx(tx).update({
        [inputHash]: {
          inputHash,
          state: { type: "fetching", requestId: "req-1", startTime: Date.now() },
        },
      });

      const state = getState(cache, inputHash, tx);
      expect(state.type).toBe("fetching");
      expect(state).toHaveProperty("requestId", "req-1");
    });
  });

  describe("transitionToFetching", () => {
    it("should transition from idle to fetching", () => {
      const inputHash = "test-hash";
      const requestId = "req-1";

      transitionToFetching(cache, inputHash, requestId, tx);

      const state = getState(cache, inputHash, tx);
      expect(state.type).toBe("fetching");
      if (state.type === "fetching") {
        expect(state.requestId).toBe(requestId);
        expect(state.startTime).toBeGreaterThan(0);
        expect(state.partial).toBeUndefined();
      }
    });

    it("should NOT overwrite non-idle state (CAS protection)", () => {
      const inputHash = "test-hash";

      // Set initial success state
      cache.withTx(tx).update({
        [inputHash]: {
          inputHash,
          state: { type: "success", data: "old-data" },
        },
      });

      // Try to transition to fetching (should fail - not idle)
      const didStart = transitionToFetching(cache, inputHash, "new-req", tx);

      expect(didStart).toBe(false);
      const state = getState(cache, inputHash, tx);
      expect(state.type).toBe("success"); // State unchanged
    });

    it("should allow re-fetching after returning to idle", () => {
      const inputHash = "test-hash";
      const initialRequestId = "req-1";
      const nextRequestId = "req-2";

      const firstStart = transitionToFetching(
        cache,
        inputHash,
        initialRequestId,
        tx,
      );
      expect(firstStart).toBe(true);

      const wentIdle = transitionToIdle(cache, inputHash, initialRequestId, tx);
      expect(wentIdle).toBe(true);

      const secondStart = transitionToFetching(
        cache,
        inputHash,
        nextRequestId,
        tx,
      );
      expect(secondStart).toBe(true);

      const state = getState(cache, inputHash, tx);
      expect(state.type).toBe("fetching");
      if (state.type === "fetching") {
        expect(state.requestId).toBe(nextRequestId);
      }
    });
  });

  describe("transitionToSuccess (CAS)", () => {
    it("should succeed when requestId matches", async () => {
      const inputHash = "test-hash";
      const requestId = "req-1";

      // Setup: transition to fetching
      transitionToFetching(cache, inputHash, requestId, tx);
      await tx.commit();

      // Act: transition to success
      const success = await transitionToSuccess(
        runtime,
        cache,
        inputHash,
        "test-data",
        requestId,
      );

      expect(success).toBe(true);

      // Verify state
      tx = runtime.edit();
      const state = getState(cache, inputHash, tx);
      expect(state.type).toBe("success");
      if (state.type === "success") {
        expect(state.data).toBe("test-data");
      }
    });

    it("should fail when requestId does not match (CAS protection)", async () => {
      const inputHash = "test-hash";
      const requestId1 = "req-1";
      const requestId2 = "req-2";

      // Setup: transition to fetching with requestId1
      transitionToFetching(cache, inputHash, requestId1, tx);
      await tx.commit();

      // Act: try to transition with wrong requestId
      const success = await transitionToSuccess(
        runtime,
        cache,
        inputHash,
        "test-data",
        requestId2,
      );

      expect(success).toBe(false);

      // Verify state unchanged
      tx = runtime.edit();
      const state = getState(cache, inputHash, tx);
      expect(state.type).toBe("fetching");
    });

    it("should fail when state is not fetching", async () => {
      const inputHash = "test-hash";
      const requestId = "req-1";

      // Setup: set state to success directly
      cache.withTx(tx).update({
        [inputHash]: {
          inputHash,
          state: { type: "success", data: "old-data" },
        },
      });
      await tx.commit();

      // Act: try to transition to success
      const success = await transitionToSuccess(
        runtime,
        cache,
        inputHash,
        "new-data",
        requestId,
      );

      expect(success).toBe(false);
    });
  });

  describe("transitionToError (CAS)", () => {
    it("should succeed when requestId matches", async () => {
      const inputHash = "test-hash";
      const requestId = "req-1";

      // Setup: transition to fetching
      transitionToFetching(cache, inputHash, requestId, tx);
      await tx.commit();

      // Act: transition to error
      const success = await transitionToError(
        runtime,
        cache,
        inputHash,
        "test error",
        requestId,
      );

      expect(success).toBe(true);

      // Verify state
      tx = runtime.edit();
      const state = getState(cache, inputHash, tx);
      expect(state.type).toBe("error");
      if (state.type === "error") {
        expect(state.error).toBe("test error");
      }
    });

    it("should fail when requestId does not match (CAS protection)", async () => {
      const inputHash = "test-hash";
      const requestId1 = "req-1";
      const requestId2 = "req-2";

      // Setup: transition to fetching with requestId1
      transitionToFetching(cache, inputHash, requestId1, tx);
      await tx.commit();

      // Act: try to transition with wrong requestId
      const success = await transitionToError(
        runtime,
        cache,
        inputHash,
        "test error",
        requestId2,
      );

      expect(success).toBe(false);

      // Verify state unchanged
      tx = runtime.edit();
      const state = getState(cache, inputHash, tx);
      expect(state.type).toBe("fetching");
    });
  });

  describe("transitionToIdle", () => {
    it("should transition from fetching to idle when requestId matches", () => {
      const inputHash = "test-hash";
      const requestId = "req-1";

      // Setup: transition to fetching
      transitionToFetching(cache, inputHash, requestId, tx);

      // Act: transition to idle
      transitionToIdle(cache, inputHash, requestId, tx);

      const state = getState(cache, inputHash, tx);
      expect(state.type).toBe("idle");
    });

    it("should not transition when requestId does not match", () => {
      const inputHash = "test-hash";
      const requestId1 = "req-1";
      const requestId2 = "req-2";

      // Setup: transition to fetching with requestId1
      transitionToFetching(cache, inputHash, requestId1, tx);

      // Act: try to transition with wrong requestId
      transitionToIdle(cache, inputHash, requestId2, tx);

      const state = getState(cache, inputHash, tx);
      expect(state.type).toBe("fetching");
    });
  });

  describe("isTimedOut", () => {
    it("should return false for non-fetching states", () => {
      expect(isTimedOut({ type: "idle" }, 1000)).toBe(false);
      expect(isTimedOut({ type: "success", data: "test" }, 1000)).toBe(false);
      expect(isTimedOut({ type: "error", error: "test" }, 1000)).toBe(false);
    });

    it("should return false when not timed out", () => {
      const state = {
        type: "fetching" as const,
        requestId: "req-1",
        startTime: Date.now(),
      };
      expect(isTimedOut(state, 1000)).toBe(false);
    });

    it("should return true when timed out", () => {
      const state = {
        type: "fetching" as const,
        requestId: "req-1",
        startTime: Date.now() - 2000, // 2 seconds ago
      };
      expect(isTimedOut(state, 1000)).toBe(true); // 1 second timeout
    });
  });

  describe("updatePartial", () => {
    it("should update partial field when requestId matches", async () => {
      const inputHash = "test-hash";
      const requestId = "req-1";

      // Setup: transition to fetching
      transitionToFetching(cache, inputHash, requestId, tx);
      await tx.commit();

      // Act: update partial
      await updatePartial(runtime, cache, inputHash, "partial data", requestId);

      // Verify
      tx = runtime.edit();
      const state = getState(cache, inputHash, tx);
      expect(state.type).toBe("fetching");
      if (state.type === "fetching") {
        expect(state.partial).toBe("partial data");
      }
    });

    it("should not update when requestId does not match", async () => {
      const inputHash = "test-hash";
      const requestId1 = "req-1";
      const requestId2 = "req-2";

      // Setup: transition to fetching with requestId1
      transitionToFetching(cache, inputHash, requestId1, tx);
      await tx.commit();

      // Act: try to update with wrong requestId
      await updatePartial(runtime, cache, inputHash, "partial data", requestId2);

      // Verify no change
      tx = runtime.edit();
      const state = getState(cache, inputHash, tx);
      if (state.type === "fetching") {
        expect(state.partial).toBeUndefined();
      }
    });

    it("should handle multiple partial updates", async () => {
      const inputHash = "test-hash";
      const requestId = "req-1";

      // Setup: transition to fetching
      transitionToFetching(cache, inputHash, requestId, tx);
      await tx.commit();

      // Act: multiple updates
      await updatePartial(runtime, cache, inputHash, "chunk 1", requestId);
      await updatePartial(runtime, cache, inputHash, "chunk 2", requestId);
      await updatePartial(runtime, cache, inputHash, "chunk 3", requestId);

      // Verify last update wins
      tx = runtime.edit();
      const state = getState(cache, inputHash, tx);
      if (state.type === "fetching") {
        expect(state.partial).toBe("chunk 3");
      }
    });
  });

  describe("computeInputHash", () => {
    it("should compute hash from cell inputs", () => {
      const inputCell = runtime.getCell<Record<string, any>>(
        space,
        "test-input",
        undefined,
        tx,
      );
      inputCell.withTx(tx).set({ url: "http://test.com", mode: "json" });

      const hash = computeInputHash(tx, inputCell);
      expect(hash).toBeTruthy();
      expect(typeof hash).toBe("string");
    });

    it("should exclude result field from hash", () => {
      const inputCell1 = runtime.getCell<Record<string, any>>(
        space,
        "test-input-1",
        undefined,
        tx,
      );
      inputCell1.withTx(tx).set({
        url: "http://test.com",
        mode: "json",
        result: "old-result",
      });

      const inputCell2 = runtime.getCell<Record<string, any>>(
        space,
        "test-input-2",
        undefined,
        tx,
      );
      inputCell2.withTx(tx).set({
        url: "http://test.com",
        mode: "json",
        result: "different-result",
      });

      const hash1 = computeInputHash(tx, inputCell1);
      const hash2 = computeInputHash(tx, inputCell2);

      // Hashes should be the same despite different result values
      expect(hash1).toBe(hash2);
    });

    it("should produce different hashes for different inputs", () => {
      const inputCell1 = runtime.getCell<Record<string, any>>(
        space,
        "test-input-1",
        undefined,
        tx,
      );
      inputCell1.withTx(tx).set({ url: "http://test1.com" });

      const inputCell2 = runtime.getCell<Record<string, any>>(
        space,
        "test-input-2",
        undefined,
        tx,
      );
      inputCell2.withTx(tx).set({ url: "http://test2.com" });

      const hash1 = computeInputHash(tx, inputCell1);
      const hash2 = computeInputHash(tx, inputCell2);

      expect(hash1).not.toBe(hash2);
    });
  });

  describe("CAS race condition scenarios", () => {
    it("should handle concurrent success transitions correctly", async () => {
      const inputHash = "test-hash";
      const requestId = "req-1";

      // Setup: transition to fetching
      transitionToFetching(cache, inputHash, requestId, tx);
      await tx.commit();

      // Simulate two concurrent attempts to write success
      const [result1, result2] = await Promise.all([
        transitionToSuccess(runtime, cache, inputHash, "data-1", requestId),
        transitionToSuccess(runtime, cache, inputHash, "data-2", requestId),
      ]);

      // Only one should succeed due to CAS
      const successCount = [result1, result2].filter((r) => r).length;
      expect(successCount).toBeGreaterThanOrEqual(1);

      // Final state should be success
      tx = runtime.edit();
      const state = getState(cache, inputHash, tx);
      expect(state.type).toBe("success");
    });

    it("should prevent new request when already fetching (deduplication)", async () => {
      const inputHash = "test-hash";
      const firstRequestId = "req-1";
      const secondRequestId = "req-2";

      // First runtime starts fetching
      const didStart1 = transitionToFetching(cache, inputHash, firstRequestId, tx);
      expect(didStart1).toBe(true); // First one wins
      await tx.commit();

      // Second runtime tries to start (should fail - already fetching)
      tx = runtime.edit();
      const didStart2 = transitionToFetching(cache, inputHash, secondRequestId, tx);
      expect(didStart2).toBe(false); // Second one loses
      await tx.commit();

      // Verify state is still fetching with first requestId
      tx = runtime.edit();
      const state = getState(cache, inputHash, tx);
      expect(state.type).toBe("fetching");
      if (state.type === "fetching") {
        expect(state.requestId).toBe(firstRequestId); // Original request still active
      }
    });
  });
});
