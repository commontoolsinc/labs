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
  getPersistentSchedulerStateConfig,
  resetCommitPreconditionsConfig,
  resetPersistentSchedulerStateConfig,
} from "@commonfabric/memory/v2";

const signer = await Identity.fromPassphrase("test experimental");

// `experimentalInterpreter` is defaulted ON by the same env signal the runtime
// reads (`CF_EXPERIMENTAL_INTERPRETER`), so the exact-shape expectations below
// must derive it from that signal to stay correct under BOTH flag-on and
// flag-off without weakening the exhaustive `toEqual` key check. Mirrors
// `envExperimentalInterpreterDefault()` in runtime.ts: `undefined` when unset,
// which `toEqual` treats as an absent key (so the off path is unchanged).
const envExperimentalInterpreter: boolean | undefined = (() => {
  const value = Deno.env.get("CF_EXPERIMENTAL_INTERPRETER");
  return value === "1" || value === "true" ? true : undefined;
})();

/**
 * Tests for the `ExperimentalOptions` feature-flag system: verifies that
 * `Runtime` construction/disposal correctly propagates flags to all the ambient
 * configs.
 */
describe("ExperimentalOptions", () => {
  afterEach(() => {
    resetModernCellRepConfig();
    resetCommitPreconditionsConfig();
    resetPersistentSchedulerStateConfig();
  });

  describe("Runtime construction", () => {
    it("respects explicitly-set flags (all false)", async () => {
      const sm = StorageManager.emulate({ as: signer });
      const runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: sm,
        experimental: {
          modernCellRep: false,
        },
      });
      expect(runtime.experimental).toEqual({
        modernCellRep: false,
        persistentSchedulerState: false,
        commitPreconditions: false,
        experimentalInterpreter: envExperimentalInterpreter,
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
        persistentSchedulerState: false,
        commitPreconditions: false,
        experimentalInterpreter: envExperimentalInterpreter,
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
        persistentSchedulerState: false,
        commitPreconditions: false,
        experimentalInterpreter: envExperimentalInterpreter,
      });
      await runtime.dispose();
      await sm.close();
    });
  });

  describe("Runtime sets and resets global config", () => {
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

    it("constructing Runtime with persistentSchedulerState sets global config", async () => {
      const sm = StorageManager.emulate({ as: signer });
      const runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: sm,
        experimental: {
          persistentSchedulerState: true,
        },
      });

      expect(getPersistentSchedulerStateConfig()).toBe(true);

      await runtime.dispose();
      await sm.close();
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
      expect(getPersistentSchedulerStateConfig()).toBe(false);
      expect(getCommitPreconditionsConfig()).toBe(false);
    });
  });
});
