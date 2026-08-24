/**
 * Tests for the `ExperimentalOptions` feature-flag system: verifies that
 * `Runtime` construction/disposal correctly resolves flags and propagates the
 * flags whose consumers are ambient.
 */

import { expect } from "@std/expect";
import { afterEach, describe, it } from "@std/testing/bdd";

import {
  getModernCellRepConfig,
  resetModernCellRepConfig,
} from "@commonfabric/data-model/cell-rep";
import { Identity } from "@commonfabric/identity";
import {
  getCommitPreconditionsConfig,
  getServerExecutionConfig,
  resetCommitPreconditionsConfig,
  resetServerExecutionConfig,
} from "@commonfabric/memory/v2";
import { ExecutorHost } from "../src/executor/host.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import {
  EXPERIMENTAL_DEFAULTS,
  type ExperimentalOptions,
  nonDefaultExperimentalFlags,
  Runtime,
} from "../src/runtime.ts";
import { runtimePresets } from "../src/runtime-presets.ts";

const signer = await Identity.fromPassphrase("test experimental");

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
          lazyMaterialization: false,
        },
      });
      expect(runtime.experimental).toEqual({
        modernCellRep: false,
        contentAddressedSchemas: true,
        commitPreconditions: false,
        plainResultReceipts: false,
        computedCellIds: false,
        lazyMaterialization: false,
        systemPatternAutoUpdate: false,
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
        contentAddressedSchemas: true,
        commitPreconditions: true,
        plainResultReceipts: true,
        computedCellIds: true,
        lazyMaterialization: true,
        systemPatternAutoUpdate: false,
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
        contentAddressedSchemas: true,
        commitPreconditions: true,
        plainResultReceipts: true,
        computedCellIds: true,
        lazyMaterialization: true,
        systemPatternAutoUpdate: false,
        serverExecution: false,
      });
      await runtime.dispose();
      await sm.close();
    });
  });

  // What the startup banner reports. It exists so an operator can check that
  // a flag took effect, and the answer to that is what is UNUSUAL about this
  // process — a list of everything resolved buries it. Two ways that went
  // wrong before the defaults table: the deployed presets select the fleet's
  // own server-execution arm explicitly, and a client that is not built
  // alongside its server adopts the deployment's whole posture explicitly, so
  // both printed a banner on every construction while running nothing unusual.
  describe("EXPERIMENTAL_DEFAULTS", () => {
    it("is what a runtime with no flags set actually resolves", async () => {
      // The table is advertised as the place to change a default, so an entry
      // that only SAYS what the default is would be worse than none: three
      // flags resolve from an ambient module's own state, and a restated copy
      // could not move them. Those entries are imported from that module, and
      // this is what catches one going back to a literal.
      const sm = StorageManager.emulate({ as: signer });
      try {
        const runtime = new Runtime({
          apiUrl: new URL(import.meta.url),
          storageManager: sm,
        });
        try {
          // `serverExecution` apart: a flag-less runtime resolves the
          // PROCESS's arm, not the fleet default this table carries for it.
          const { serverExecution: _resolvedArm, ...resolved } =
            runtime.experimental;
          const { serverExecution: _fleetDefault, ...defaults } =
            EXPERIMENTAL_DEFAULTS;
          expect(resolved).toEqual(defaults);
          expect(runtime.experimental.serverExecution).toBe(
            getServerExecutionConfig(),
          );
        } finally {
          await runtime.dispose();
        }
      } finally {
        await sm.close();
      }
    });
  });

  describe("nonDefaultExperimentalFlags()", () => {
    const resolved = (over: ExperimentalOptions = {}): ExperimentalOptions => ({
      ...EXPERIMENTAL_DEFAULTS,
      ...over,
    });

    it("returns nothing for a runtime running every default", () => {
      expect(nonDefaultExperimentalFlags(resolved(), {})).toEqual([]);
    });

    it("names a default-off flag that is on", () => {
      expect(nonDefaultExperimentalFlags(resolved({ modernCellRep: true }), {}))
        .toEqual(["modernCellRep=true"]);
    });

    it("names a default-on flag that is off", () => {
      expect(
        nonDefaultExperimentalFlags(
          resolved({ lazyMaterialization: false }),
          {},
        ),
      ).toEqual(["lazyMaterialization=false"]);
    });

    it("names every diverging flag, in flag order", () => {
      expect(
        nonDefaultExperimentalFlags(
          resolved({ modernCellRep: true, computedCellIds: false }),
          {},
        ),
      ).toEqual(["modernCellRep=true", "computedCellIds=false"]);
    });

    it("says nothing of an unselected serverExecution, whatever the process resolved", () => {
      // A flag-less runtime in a serving process inherits the process's arm
      // rather than choosing one; reporting that as ITS divergence would be a
      // claim about a decision it did not make.
      expect(
        nonDefaultExperimentalFlags(
          resolved({ serverExecution: !EXPERIMENTAL_DEFAULTS.serverExecution }),
          {},
        ),
      ).toEqual([]);
    });

    it("says nothing of a serverExecution selected at the fleet default", () => {
      // The deployed-topology presets always pass it, so this is the case
      // that used to print on every toolshed start and every cf command.
      expect(
        nonDefaultExperimentalFlags(resolved(), {
          serverExecution: EXPERIMENTAL_DEFAULTS.serverExecution,
        }),
      ).toEqual([]);
    });

    it("names a serverExecution arm selected against the fleet default", () => {
      const other = !EXPERIMENTAL_DEFAULTS.serverExecution;
      expect(
        nonDefaultExperimentalFlags(resolved({ serverExecution: other }), {
          serverExecution: other,
        }),
      ).toEqual([`serverExecution=${other}`]);
    });
  });

  describe("the startup banner", () => {
    /** Runs `body` with this process's stderr captured. */
    const captureStderr = async (
      body: () => Promise<void>,
    ): Promise<string> => {
      const stderr = Deno.stderr as unknown as {
        writeSync: (bytes: Uint8Array) => number;
      };
      const real = stderr.writeSync.bind(Deno.stderr);
      let written = "";
      stderr.writeSync = (bytes: Uint8Array) => {
        written += new TextDecoder().decode(bytes);
        return bytes.length;
      };
      try {
        await body();
      } finally {
        stderr.writeSync = real;
      }
      return written;
    };

    const withRuntime = async (
      experimental: ExperimentalOptions,
      preset: "unitTest" | "productionServer",
    ): Promise<string> => {
      const sm = StorageManager.emulate({ as: signer });
      const options = { apiUrl: new URL(import.meta.url), storageManager: sm };
      try {
        return await captureStderr(async () => {
          const runtime = new Runtime(
            preset === "productionServer"
              ? runtimePresets.productionServer({ ...options, experimental })
              : runtimePresets.unitTest({ ...options, experimental }),
          );
          await runtime.dispose();
        });
      } finally {
        await sm.close();
      }
    };

    it("stays quiet for a runtime running the defaults", async () => {
      expect(await withRuntime({}, "unitTest")).toBe("");
    });

    it("stays quiet for a deployed server, which selects the fleet's own arm", async () => {
      // `productionServer` resolves an unset serverExecution to the
      // first-party default, so this construction passes it explicitly while
      // running nothing unusual.
      expect(await withRuntime({}, "productionServer")).toBe("");
    });

    it("stays quiet for a client that adopted a stock deployment's posture", async () => {
      // What `experimentalOptionsForDeployedClient` hands a cf binary when
      // the deployment runs defaults: every flag explicit, nothing unusual.
      expect(await withRuntime({ ...EXPERIMENTAL_DEFAULTS }, "unitTest"))
        .toBe("");
    });

    it("names what a runtime runs off its default", async () => {
      expect(await withRuntime({ modernCellRep: true }, "unitTest"))
        .toBe("Non-default experimental flags: modernCellRep=true\n");
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

// ---------------------------------------------------------------------------
// The serverExecution ambient-flag OWNERSHIP family (PR #5439 threads
// r3731191424, r3731191435, r3731191451): the flag is a process-global
// admission input, so its lifecycle must be reference-counted across ALL
// owners (explicit-enabler Runtimes AND the ExecutorHost), survive
// construction/dispose failures, and never be stomped by a co-hosted
// non-serving runtime.
// ---------------------------------------------------------------------------

describe("serverExecution ambient-flag ownership", () => {
  afterEach(() => {
    resetModernCellRepConfig();
    resetCommitPreconditionsConfig();
    resetServerExecutionConfig();
  });

  it("a co-hosted explicit-false Runtime must not un-claim the ambient flag while an enabler is live", async () => {
    const smEnabler = StorageManager.emulate({ as: signer });
    const enabler = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: smEnabler,
      experimental: { serverExecution: true },
    });
    expect(getServerExecutionConfig()).toBe(true);

    const smDisabled = StorageManager.emulate({ as: signer });
    const disabled = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: smDisabled,
      experimental: { serverExecution: false },
    });
    // The live serving enabler keeps the ambient admission claim: an
    // explicit-false construction elsewhere in the process must not
    // silently un-claim `derived` mid-serve.
    expect(getServerExecutionConfig()).toBe(true);
    // The explicit-false runtime keeps its OWN posture.
    expect(disabled.experimental.serverExecution).toBe(false);

    await disabled.dispose();
    expect(getServerExecutionConfig()).toBe(true);
    await enabler.dispose();
    expect(getServerExecutionConfig()).toBe(false);
    await smDisabled.close();
    await smEnabler.close();
  });

  it("a THROWING construction rolls its enabler back instead of poisoning the process-global lifecycle", async () => {
    const smBad = StorageManager.emulate({ as: signer });
    expect(() =>
      new Runtime({
        apiUrl: "::not a url::" as never,
        storageManager: smBad,
        experimental: { serverExecution: true },
      })
    ).toThrow();
    // The failed construction must not leak an enabler: a later
    // well-formed enabler's dispose still resets the ambient flag.
    const sm = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: sm,
      experimental: { serverExecution: true },
    });
    expect(getServerExecutionConfig()).toBe(true);
    await runtime.dispose();
    expect(getServerExecutionConfig()).toBe(false);
    await sm.close();
    await smBad.close();
  });

  it("ExecutorHost close does not un-claim the flag while an explicit-enabler Runtime is live (shared refcount across owners)", async () => {
    const server = newSharedServer();
    const host = new ExecutorHost({
      server,
      serviceIdentity: "did:key:z6Mk-flag-test-service",
      createRuntime: () => Promise.reject(new Error("never activated")),
    });
    expect(getServerExecutionConfig()).toBe(true);

    const sm = StorageManager.emulate({ as: signer });
    const enabler = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: sm,
      experimental: { serverExecution: true },
    });

    // Host teardown while a serving runtime still lives: the ambient
    // claim must survive (its in-flight wave commits are admitted off
    // this flag).
    await host.close();
    expect(getServerExecutionConfig()).toBe(true);

    await enabler.dispose();
    expect(getServerExecutionConfig()).toBe(false);
    await sm.close();
    await server.close();
  });

  it("a REJECTING dispose still releases the enabler (the reset must not depend on a clean async teardown)", async () => {
    const sm = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: sm,
      experimental: { serverExecution: true },
    });
    expect(getServerExecutionConfig()).toBe(true);
    (runtime.scheduler as unknown as { idle: () => Promise<void> }).idle = () =>
      Promise.reject(new Error("induced dispose failure"));
    let threw = false;
    try {
      await runtime.dispose();
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    expect(getServerExecutionConfig()).toBe(false);
    await sm.close();
  });
});
