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
  getServerPrimaryExecutionConfig,
  getServerPrimaryExecutionContextLatticeClaimsConfig,
  getServerPrimaryExecutionDocSetWatchConfig,
  resetCommitPreconditionsConfig,
  resetPersistentSchedulerStateConfig,
  resetServerPrimaryExecutionConfig,
  resetServerPrimaryExecutionContextLatticeClaimsConfig,
  resetServerPrimaryExecutionDocSetWatchConfig,
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
    resetPersistentSchedulerStateConfig();
    resetServerPrimaryExecutionConfig();
    resetServerPrimaryExecutionDocSetWatchConfig();
    resetServerPrimaryExecutionContextLatticeClaimsConfig();
  });

  describe("Runtime construction", () => {
    it("respects explicitly-set flags (all false)", async () => {
      const sm = StorageManager.emulate({ as: signer });
      const runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: sm,
        experimental: {
          modernCellRep: false,
          persistentSchedulerState: false,
          commitPreconditions: false,
          serverPrimaryExecution: false,
          computedCellIds: false,
        },
      });
      expect(runtime.experimental).toEqual({
        modernCellRep: false,
        persistentSchedulerState: false,
        commitPreconditions: false,
        serverPrimaryExecution: false,
        // Env-resolved (F4's doc-set watch flag): false with the env unset.
        serverPrimaryExecutionDocSetWatch: false,
        // Same, for C1.7's context-lattice-claims negotiation flag, which
        // defaults ON with the rest of the server-primary dial set.
        serverPrimaryExecutionContextLatticeClaims: true,
        // The three CANDIDATE dials have no ambient control point; the
        // constructor normalizes them locally, and they default on with the
        // set. Not named in `experimental` above, so these are the defaults —
        // an explicit `serverPrimaryExecution: false` does NOT drag them down,
        // because they are inert without the master flag anyway (no executor
        // exists to produce a candidate).
        serverPrimaryExecutionUserRankCandidates: true,
        serverPrimaryExecutionSessionRankCandidates: true,
        serverPrimaryExecutionCrossSpaceReadCandidates: true,
        computedCellIds: false,
        // Read back from the ambient flag (a test seam that deliberately does
        // NOT reset on dispose — see ExperimentalOptions.eagerSourceAnnotation).
        eagerSourceAnnotation: false,
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
          persistentSchedulerState: true,
          serverPrimaryExecution: true,
        },
      });
      expect(runtime.experimental).toEqual({
        modernCellRep: true,
        persistentSchedulerState: true,
        commitPreconditions: true,
        serverPrimaryExecution: true,
        serverPrimaryExecutionDocSetWatch: false,
        serverPrimaryExecutionContextLatticeClaims: true,
        serverPrimaryExecutionUserRankCandidates: true,
        serverPrimaryExecutionSessionRankCandidates: true,
        serverPrimaryExecutionCrossSpaceReadCandidates: true,
        computedCellIds: true,
        eagerSourceAnnotation: false,
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
      // The DEFAULT CONFIGURATION, in one place. The server-primary dial set
      // moves as one and is on; the doc-set watch feed is deliberately not
      // part of that set (its rollout gate is the separate W2.9 measurement).
      expect(runtime.experimental).toEqual({
        modernCellRep: false,
        persistentSchedulerState: true,
        commitPreconditions: true,
        serverPrimaryExecution: true,
        serverPrimaryExecutionDocSetWatch: false,
        serverPrimaryExecutionContextLatticeClaims: true,
        serverPrimaryExecutionUserRankCandidates: true,
        serverPrimaryExecutionSessionRankCandidates: true,
        serverPrimaryExecutionCrossSpaceReadCandidates: true,
        computedCellIds: true,
        // Read back from the ambient flag (a test seam that deliberately does
        // NOT reset on dispose — see ExperimentalOptions.eagerSourceAnnotation).
        eagerSourceAnnotation: false,
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

    it("explicit false keeps persistentSchedulerState available as rollback", async () => {
      const sm = StorageManager.emulate({ as: signer });
      const runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: sm,
        experimental: {
          persistentSchedulerState: false,
        },
      });

      expect(getPersistentSchedulerStateConfig()).toBe(false);

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

    it("constructing Runtime with serverPrimaryExecution sets global config", async () => {
      const sm = StorageManager.emulate({ as: signer });
      const runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: sm,
        experimental: {
          serverPrimaryExecution: true,
        },
      });

      expect(getServerPrimaryExecutionConfig()).toBe(true);
      expect(runtime.experimental.serverPrimaryExecution).toBe(true);

      await runtime.dispose();
      await sm.close();
    });

    // The browser own-side leg of the F5 doc-set-watch subcapability: the
    // shell worker constructs its Runtime from host-passed experimental
    // flags (build-time defines), and THIS propagation is what installs the
    // ambient dial the replica ANDs with the server-advertised subcap. Also
    // pins the layering: dispose returns both dials to their defaults.
    it("constructing Runtime with serverPrimaryExecutionDocSetWatch sets global config", async () => {
      const sm = StorageManager.emulate({ as: signer });
      const runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: sm,
        experimental: {
          serverPrimaryExecution: true,
          serverPrimaryExecutionDocSetWatch: true,
        },
      });

      expect(getServerPrimaryExecutionConfig()).toBe(true);
      expect(getServerPrimaryExecutionDocSetWatchConfig()).toBe(true);
      expect(runtime.experimental.serverPrimaryExecutionDocSetWatch).toBe(
        true,
      );

      await runtime.dispose();
      // Back to the DEFAULTS, which is not the same as back to false: the
      // base dial defaults on, the doc-set watch dial does not.
      expect(getServerPrimaryExecutionConfig()).toBe(true);
      expect(getServerPrimaryExecutionDocSetWatchConfig()).toBe(false);
      await sm.close();
    });

    // The same leg for C1.7's context-lattice-claims subcapability — the half
    // a browser had no path to before (client-passivity §5g item 5). THIS
    // propagation is what makes the realm's memory `hello` offer the subcap,
    // so the server records the session as negotiating and the amendment-11
    // cohort gate can admit a user lane. Also pins the layering and that
    // dispose returns both dials to their defaults.
    it("constructing Runtime with serverPrimaryExecutionContextLatticeClaims sets global config", async () => {
      const sm = StorageManager.emulate({ as: signer });
      const runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: sm,
        experimental: {
          serverPrimaryExecution: true,
          serverPrimaryExecutionContextLatticeClaims: true,
        },
      });

      expect(getServerPrimaryExecutionConfig()).toBe(true);
      expect(getServerPrimaryExecutionContextLatticeClaimsConfig()).toBe(true);
      expect(
        runtime.experimental.serverPrimaryExecutionContextLatticeClaims,
      ).toBe(true);
      // Layered above the base capability, and independent of the sibling
      // subcapability dial.
      expect(getServerPrimaryExecutionDocSetWatchConfig()).toBe(false);

      await runtime.dispose();
      expect(getServerPrimaryExecutionConfig()).toBe(true);
      expect(getServerPrimaryExecutionContextLatticeClaimsConfig()).toBe(true);
      await sm.close();
    });

    // The other direction of the same propagation, and the one that matters
    // now that the dial set defaults on: an explicit `false` must reach the
    // ambient, because that is the deployment's rollback lever.
    it("constructing Runtime with the server-primary dials off sets global config off", async () => {
      const sm = StorageManager.emulate({ as: signer });
      const runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: sm,
        experimental: {
          serverPrimaryExecution: false,
          serverPrimaryExecutionContextLatticeClaims: false,
        },
      });

      expect(getServerPrimaryExecutionConfig()).toBe(false);
      expect(getServerPrimaryExecutionContextLatticeClaimsConfig()).toBe(false);
      expect(runtime.experimental.serverPrimaryExecution).toBe(false);

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
      expect(getPersistentSchedulerStateConfig()).toBe(true);
      expect(getCommitPreconditionsConfig()).toBe(true);
      expect(getServerPrimaryExecutionConfig()).toBe(true);
    });
  });
});
