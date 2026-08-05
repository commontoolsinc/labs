import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import {
  getModernCellRepConfig,
  resetModernCellRepConfig,
} from "@commonfabric/data-model/cell-rep";
import {
  getCommitPreconditionsConfig,
  getServerExecutionConfig,
  resetCommitPreconditionsConfig,
  resetServerExecutionConfig,
} from "@commonfabric/memory/v2";

const signer = await Identity.fromPassphrase("test experimental");

/**
 * Tests for the `ExperimentalOptions` feature-flag system: verifies that
 * `Runtime` construction/disposal correctly resolves flags and propagates the
 * flags whose consumers are ambient.
 */
describe("ExperimentalOptions", () => {
  afterEach(() => {
    resetModernCellRepConfig();
    resetCommitPreconditionsConfig();
    resetServerExecutionConfig();
  });

  describe("Runtime construction", () => {
    it("respects explicitly-set flags (all false)", async () => {
      const sm = StorageManager.emulate({ as: signer });
      const runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: sm,
        experimental: {
          modernCellRep: false,
          commitPreconditions: false,
          plainResultReceipts: false,
          computedCellIds: false,
        },
      });
      expect(runtime.experimental).toEqual({
        modernCellRep: false,
        commitPreconditions: false,
        plainResultReceipts: false,
        computedCellIds: false,
        // Read back from the ambient flag (a test seam that deliberately does
        // NOT reset on dispose — see ExperimentalOptions.eagerSourceAnnotation).
        eagerSourceAnnotation: false,
        serverExecution: false,
      });
      await runtime.dispose();
      await sm.close();
    });

    it("respects explicitly-set flags (all true)", async () => {
      const sm = StorageManager.emulate({ as: signer });
      const runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: sm,
        experimental: {
          modernCellRep: true,
        },
      });
      expect(runtime.experimental).toEqual({
        modernCellRep: true,
        commitPreconditions: true,
        plainResultReceipts: true,
        computedCellIds: true,
        eagerSourceAnnotation: false,
        serverExecution: false,
      });
      await runtime.dispose();
      await sm.close();
    });

    it("merges provided flags with defaults", async () => {
      const sm = StorageManager.emulate({ as: signer });
      const runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: sm,
        experimental: {},
      });
      expect(runtime.experimental).toEqual({
        modernCellRep: false,
        commitPreconditions: true,
        plainResultReceipts: true,
        computedCellIds: true,
        // Read back from the ambient flag (a test seam that deliberately does
        // NOT reset on dispose — see ExperimentalOptions.eagerSourceAnnotation).
        eagerSourceAnnotation: false,
        serverExecution: false,
      });
      await runtime.dispose();
      await sm.close();
    });
  });

  describe("Runtime sets and resets ambient config", () => {
    it("constructing Runtime with modernCellRep sets global config", async () => {
      const sm = StorageManager.emulate({ as: signer });
      const runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: sm,
        experimental: {
          modernCellRep: true,
        },
      });

      expect(getModernCellRepConfig()).toBe(true);

      await runtime.dispose();
      await sm.close();
    });

    it("constructing Runtime with serverExecution sets global config", async () => {
      const sm = StorageManager.emulate({ as: signer });
      const runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: sm,
        experimental: {
          serverExecution: true,
        },
      });

      expect(getServerExecutionConfig()).toBe(true);
      expect(runtime.experimental.serverExecution).toBe(true);

      await runtime.dispose();
      await sm.close();

      expect(getServerExecutionConfig()).toBe(false);
    });

    it("constructing Runtime with commitPreconditions sets global config", async () => {
      const sm = StorageManager.emulate({ as: signer });
      const runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: sm,
        experimental: {
          commitPreconditions: true,
        },
      });

      expect(getCommitPreconditionsConfig()).toBe(true);

      await runtime.dispose();
      await sm.close();
    });

    it("constructing Runtime with explicit false sets config to false", async () => {
      const sm = StorageManager.emulate({ as: signer });
      const runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: sm,
        experimental: { modernCellRep: false },
      });

      expect(getModernCellRepConfig()).toBe(false);

      await runtime.dispose();
      await sm.close();
    });

    it("constructing Runtime with explicit true sets config to true", async () => {
      const sm = StorageManager.emulate({ as: signer });
      const runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: sm,
        experimental: { modernCellRep: true },
      });

      expect(getModernCellRepConfig()).toBe(true);

      await runtime.dispose();
      await sm.close();
    });

    it("disposing Runtime resets global config to the default", async () => {
      const initial = getModernCellRepConfig();
      const sm = StorageManager.emulate({ as: signer });
      const runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: sm,
        experimental: {
          modernCellRep: !initial,
        },
      });

      expect(getModernCellRepConfig()).toBe(!initial);

      await runtime.dispose();
      await sm.close();

      expect(getModernCellRepConfig()).toBe(initial);
      expect(getCommitPreconditionsConfig()).toBe(true);
      expect(getServerExecutionConfig()).toBe(false);
    });
  });
});
