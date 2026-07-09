import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  EXPERIMENTAL_ENV_VARS,
  experimentalOptionsFromEnv,
  RUNTIME_OPTION_KEYS,
  type RuntimeOptionKey,
  runtimePresets,
} from "../src/runtime-presets.ts";
import type { ExperimentalOptions, RuntimeOptions } from "../src/runtime.ts";
import type { IStorageManager } from "../src/storage/interface.ts";
import { Runtime, signer, StorageManager } from "./engine-test-support.ts";

/**
 * Conformance guard for CT-1814 (the construction-config axis of CT-1811).
 *
 * The presets exist so a new `RuntimeOptions` key — or a changed default —
 * cannot land unevenly across first-party environments. Two mechanisms are
 * pinned here:
 *
 * 1. TREATMENT: for every registered option key, each preset's minimal-args
 *    output must match the declared classification (per-site sentinel /
 *    core-pinned value / pinned-in-family / absent). `MINIMAL_TREATMENT` is
 *    a `Record<RuntimeOptionKey, ...>`, so registering a new option in
 *    `RUNTIME_OPTION_KEYS` forces a row here too — the compiler walks a new
 *    option all the way into this spec.
 * 2. DELTA ROUTING: every declared preset parameter must land on exactly its
 *    `RuntimeOptions` key (full-args goldens), so a param cannot be silently
 *    dropped or mis-mapped.
 */

type PresetName = keyof typeof runtimePresets;
const PRESET_NAMES = Object.keys(runtimePresets) as PresetName[];

const apiUrl = new URL("https://conformance.example/api");
const storageManager = {
  id: "conformance-storage",
} as unknown as IStorageManager;
const experimental: ExperimentalOptions = { modernCellRep: true };
const minimalCore = { apiUrl, storageManager, experimental };

const minimalOutputs: Record<PresetName, RuntimeOptions> = {
  productionServer: runtimePresets.productionServer(minimalCore),
  remoteClient: runtimePresets.remoteClient(minimalCore),
  patternTest: runtimePresets.patternTest(minimalCore),
  localDev: runtimePresets.localDev(minimalCore),
  browserWorker: runtimePresets.browserWorker(minimalCore),
  // unitTest is the one preset where `experimental` is optional (so the 282
  // hand-rolled test constructions can adopt it without ceremony).
  unitTest: runtimePresets.unitTest({ apiUrl, storageManager }),
};

/** Presets whose runtimes serve patterns against a real deployment. */
const DEPLOYMENT_FACING: PresetName[] = [
  "productionServer",
  "remoteClient",
  "browserWorker",
];

type MinimalTreatment =
  /** Equals the sentinel passed in, in every preset. */
  | { treat: "per-site" }
  /** Present in every preset with this exact shared value. */
  | { treat: "core-pinned"; value: unknown }
  /** Present (derived, not caller-supplied) in exactly these presets. */
  | { treat: "pinned-in"; presets: PresetName[]; value: unknown }
  /** No minimal output owns the key: the constructor default governs. */
  | { treat: "absent" };

const MINIMAL_TREATMENT: Record<RuntimeOptionKey, MinimalTreatment> = {
  apiUrl: { treat: "per-site" },
  storageManager: { treat: "per-site" },
  experimental: { treat: "per-site" },
  // Same value as the Runtime constructor default today; pinned so a changed
  // constructor default cannot silently relax first-party environments.
  cfcEnforcementMode: { treat: "core-pinned", value: "enforce-explicit" },
  // Deployment-facing runtimes point patterns at the deployment itself;
  // local presets keep the builder-env default (localhost fall-through).
  patternEnvironment: {
    treat: "pinned-in",
    presets: DEPLOYMENT_FACING,
    value: { apiUrl },
  },
  // Everything below rides the constructor default unless a preset's
  // declared delta param supplies it (covered by the routing tests).
  spaceHostMap: { treat: "absent" },
  clientVersion: { treat: "absent" },
  onVersionSkew: { treat: "absent" },
  consoleHandler: { treat: "absent" },
  errorHandlers: { treat: "absent" },
  navigateCallback: { treat: "absent" },
  pieceCreatedCallback: { treat: "absent" },
  debug: { treat: "absent" },
  telemetry: { treat: "absent" },
  cfcFlowLabels: { treat: "absent" },
  cfcWriteFloor: { treat: "absent" },
  cfcTriggerReadGating: { treat: "absent" },
  cfcPolicyEvaluation: { treat: "absent" },
  cfcPolicyRecords: { treat: "absent" },
  cfcTrustConfig: { treat: "absent" },
  cfcSinkMaxConfidentiality: { treat: "absent" },
  trustSnapshotProvider: { treat: "absent" },
  hideInternalStackFrames: { treat: "absent" },
  commitBackpressure: { treat: "absent" },
  moduleByteCache: { treat: "absent" },
  fetch: { treat: "absent" },
};

describe("runtimePresets conformance (CT-1814)", () => {
  it("every registered option key gets its declared treatment in every preset", () => {
    for (const key of RUNTIME_OPTION_KEYS) {
      const treatment = MINIMAL_TREATMENT[key];
      for (const preset of PRESET_NAMES) {
        const output = minimalOutputs[preset];
        const owns = Object.hasOwn(output, key);
        const context = `${preset}.${key}`;
        switch (treatment.treat) {
          case "per-site": {
            expect(owns, `${context} must be set from its param`).toBe(true);
            if (key === "experimental" && preset === "unitTest") {
              // unitTest defaulted it; every other preset got the sentinel.
              expect(output.experimental).toEqual({});
            } else {
              expect(output[key], context).toBe(
                minimalCore[
                  key as keyof typeof minimalCore
                ],
              );
            }
            break;
          }
          case "core-pinned": {
            expect(owns, `${context} must carry the shared pin`).toBe(true);
            expect(output[key], context).toEqual(treatment.value);
            break;
          }
          case "pinned-in": {
            const expected = treatment.presets.includes(preset);
            expect(
              owns,
              `${context} pinned-in mismatch (expected ${expected})`,
            ).toBe(expected);
            if (expected) expect(output[key], context).toEqual(treatment.value);
            break;
          }
          case "absent": {
            expect(
              owns,
              `${context} must ride the constructor default in minimal form`,
            ).toBe(false);
            break;
          }
        }
      }
    }
  });

  it("presets set no keys outside the registry", () => {
    for (const preset of PRESET_NAMES) {
      for (const key of Object.keys(minimalOutputs[preset])) {
        expect(RUNTIME_OPTION_KEYS, `${preset} sets unregistered "${key}"`)
          .toContain(key);
      }
    }
  });

  describe("delta routing (full-args goldens)", () => {
    const fetchSentinel = (() =>
      Promise.reject(
        new Error("sentinel"),
      )) as unknown as typeof globalThis.fetch;
    const errorHandlers = [() => {}];
    const navigateCallback = () => {};
    const consoleHandler = (
      { args }: { args: unknown[] },
    ) => args;
    const pieceCreatedCallback = () => {};
    const moduleByteCache = {
      get: () => undefined,
      set: () => {},
    } as unknown as NonNullable<RuntimeOptions["moduleByteCache"]>;
    const trustSnapshotProvider = () => undefined;
    const telemetry = {
      dispatchEvent: () => true,
    } as unknown as NonNullable<RuntimeOptions["telemetry"]>;
    const commitBackpressure = { retryWindowMs: 100 };
    const spaceHostMap = { "did:key:zSpace": "https://host.example" };
    const clientVersion = "build-sha-x";
    const onVersionSkew = () => {};

    it("productionServer", () => {
      const patternApiUrl = new URL("https://public.example/api");
      expect(runtimePresets.productionServer({
        ...minimalCore,
        patternApiUrl,
        consoleHandler,
        errorHandlers,
        telemetry,
      })).toEqual({
        ...minimalOutputs.productionServer,
        patternEnvironment: { apiUrl: patternApiUrl },
        consoleHandler,
        errorHandlers,
        telemetry,
      });
    });

    it("remoteClient", () => {
      expect(runtimePresets.remoteClient({
        ...minimalCore,
        errorHandlers,
        navigateCallback,
        moduleByteCache,
        trustSnapshotProvider,
      })).toEqual({
        ...minimalOutputs.remoteClient,
        errorHandlers,
        navigateCallback,
        moduleByteCache,
        trustSnapshotProvider,
      });
    });

    it("patternTest", () => {
      expect(runtimePresets.patternTest({
        ...minimalCore,
        fetch: fetchSentinel,
        errorHandlers,
        navigateCallback,
        moduleByteCache,
        cfcEnforcementMode: "observe",
      })).toEqual({
        ...minimalOutputs.patternTest,
        fetch: fetchSentinel,
        errorHandlers,
        navigateCallback,
        moduleByteCache,
        cfcEnforcementMode: "observe",
      });
    });

    it("browserWorker", () => {
      expect(runtimePresets.browserWorker({
        ...minimalCore,
        spaceHostMap,
        clientVersion,
        cfcEnforcementMode: "observe",
        cfcFlowLabels: "observe",
        trustSnapshotProvider,
        telemetry,
        consoleHandler,
        errorHandlers,
        navigateCallback,
        pieceCreatedCallback,
        onVersionSkew,
      })).toEqual({
        ...minimalOutputs.browserWorker,
        spaceHostMap,
        clientVersion,
        cfcEnforcementMode: "observe",
        cfcFlowLabels: "observe",
        trustSnapshotProvider,
        telemetry,
        consoleHandler,
        errorHandlers,
        navigateCallback,
        pieceCreatedCallback,
        onVersionSkew,
      });
    });

    it("unitTest", () => {
      expect(runtimePresets.unitTest({
        apiUrl,
        storageManager,
        experimental,
        fetch: fetchSentinel,
        errorHandlers,
        moduleByteCache,
        cfcEnforcementMode: "disabled",
        commitBackpressure,
      })).toEqual({
        ...minimalOutputs.unitTest,
        experimental,
        fetch: fetchSentinel,
        errorHandlers,
        moduleByteCache,
        cfcEnforcementMode: "disabled",
        commitBackpressure,
      });
    });
  });

  describe("experimentalOptionsFromEnv", () => {
    it("consults exactly the env-wired canonical mapping", () => {
      const read: string[] = [];
      experimentalOptionsFromEnv((name) => {
        read.push(name);
        return undefined;
      });
      const wired = Object.values(EXPERIMENTAL_ENV_VARS)
        .flatMap((v) => v === null ? [] : [v]);
      expect(read.toSorted()).toEqual(wired.toSorted());
    });

    it("parses canonical values and leaves unset flags to their defaults", () => {
      const env: Record<string, string> = {
        EXPERIMENTAL_MODERN_CELL_REP: "true",
        EXPERIMENTAL_PERSISTENT_SCHEDULER_STATE: "false",
      };
      expect(experimentalOptionsFromEnv((name) => env[name])).toEqual({
        modernCellRep: true,
        persistentSchedulerState: false,
      });
      expect(experimentalOptionsFromEnv(() => undefined)).toEqual({});
    });

    it("ignores (with a warning) non-canonical values instead of coercing", () => {
      // The wirings this replaced coerced garbage in OPPOSITE directions
      // (toolshed's flagValue(): anything but "false" ⇒ true; the CLI reader:
      // anything but "true" ⇒ false). Ignoring keeps the flag on its default
      // and surfaces the typo.
      const warnings: unknown[][] = [];
      const originalWarn = console.warn;
      console.warn = (...args: unknown[]) => {
        warnings.push(args);
      };
      try {
        expect(
          experimentalOptionsFromEnv((name) =>
            name === "EXPERIMENTAL_MODERN_CELL_REP" ? "1" : undefined
          ),
        ).toEqual({});
      } finally {
        console.warn = originalWarn;
      }
      expect(warnings.length).toBe(1);
      expect(String(warnings[0][0])).toContain("EXPERIMENTAL_MODERN_CELL_REP");
    });
  });

  it("preset output constructs a working Runtime", async () => {
    const emulated = StorageManager.emulate({ as: signer });
    const runtime = new Runtime(runtimePresets.unitTest({
      apiUrl: new URL(import.meta.url),
      storageManager: emulated,
    }));
    try {
      expect(runtime.cfcEnforcementMode).toBe("enforce-explicit");
    } finally {
      await runtime.dispose();
      await emulated.close();
    }
  });
});
