/**
 * The one posture record, and the property that makes it worth having: a
 * surface that projects a runtime's posture before the runtime exists — a
 * console printing at startup, a harness recording a lazily-built session —
 * must arrive at the record the constructed runtime does.
 *
 * The parity assertions construct a real `Runtime` from each preset and
 * compare its record against the projection built from that preset's options
 * alone. A default the projection restates in its own words rather than
 * reading from the shared table fails here the moment the two disagree,
 * which is the whole reason the table is shared.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  cfcPostureReport,
  KNOWN_SINKS,
  projectedCfcPostureReport,
  RUNTIME_CFC_DIAL_DEFAULTS,
} from "../src/cfc/mod.ts";
import type { RuntimeOptions } from "../src/runtime.ts";
import { presetCfcOptions, runtimePresets } from "../src/runtime-presets.ts";
import { Runtime, signer, StorageManager } from "./engine-test-support.ts";

/** The record a surface projects from options alone, with no Runtime. */
const projected = (options: RuntimeOptions) =>
  projectedCfcPostureReport(options);

describe("the CFC posture record", () => {
  describe("dial rendering", () => {
    it("marks an observe rung as deciding nothing", () => {
      const record = cfcPostureReport({
        ...RUNTIME_CFC_DIAL_DEFAULTS,
        cfcPolicyEvaluation: "observe",
        cfcPolicySnapshot: undefined,
        cfcSinkMaxConfidentiality: {},
      });
      expect(record.policyEvaluation.rung).toBe("observe");
      expect(record.policyEvaluation.diagnosticOnly).toBe(true);
      expect(record.policyEvaluation.decidesOn).toContain("un-rewritten");
    });

    it("marks an enforcing rung as deciding on something", () => {
      const record = cfcPostureReport({
        ...RUNTIME_CFC_DIAL_DEFAULTS,
        cfcPolicyEvaluation: "enforce",
        cfcPolicySnapshot: undefined,
        cfcSinkMaxConfidentiality: {},
      });
      expect(record.policyEvaluation.diagnosticOnly).toBe(false);
      expect(record.policyEvaluation.decidesOn).toContain("rewritten label");
    });
  });

  describe("sink governance", () => {
    it("lists every known sink, ungated ones included", () => {
      const record = cfcPostureReport({
        ...RUNTIME_CFC_DIAL_DEFAULTS,
        cfcPolicySnapshot: undefined,
        cfcSinkMaxConfidentiality: { fetchText: [] },
      });
      expect(record.sinks.map((sink) => sink.sink)).toEqual([...KNOWN_SINKS]);
      const fetchText = record.sinks.find((sink) => sink.sink === "fetchText");
      expect(fetchText).toEqual({ sink: "fetchText", ceiling: [] });
      const fetchJson = record.sinks.find((sink) => sink.sink === "fetchJson");
      expect(fetchJson).toEqual({
        sink: "fetchJson",
        ungated: "no confidentiality ceiling is configured for this sink",
      });
    });

    it("publishes a deliberately ungated sink as a deviation with an owner and a retirement", () => {
      const record = cfcPostureReport({
        ...RUNTIME_CFC_DIAL_DEFAULTS,
        cfcPolicySnapshot: undefined,
        cfcSinkMaxConfidentiality: {},
      });
      const llm = record.deviations.filter((deviation) =>
        deviation.what.includes("`llm`")
      );
      expect(llm.length).toBe(1);
      expect(llm[0]!.owner.length).toBeGreaterThan(0);
      expect(llm[0]!.retirement.length).toBeGreaterThan(0);
    });

    it("reports no deviation for a sink the deployment ceilings", () => {
      const record = cfcPostureReport({
        ...RUNTIME_CFC_DIAL_DEFAULTS,
        cfcPolicySnapshot: undefined,
        cfcSinkMaxConfidentiality: { llm: [], llmDialog: [] },
      });
      expect(
        record.deviations.map((deviation) => deviation.what).filter((what) =>
          what.includes("`llm`") || what.includes("`llmDialog`")
        ),
      ).toEqual([]);
    });
  });

  describe("parity with a constructed Runtime", () => {
    const emulated = () => StorageManager.emulate({ as: signer });
    const cases: readonly [string, () => RuntimeOptions][] = [
      ["unitTest", () =>
        runtimePresets.unitTest({
          apiUrl: new URL(import.meta.url),
          storageManager: emulated(),
        })],
      ["unitTest under max-enforcement", () =>
        runtimePresets.unitTest({
          apiUrl: new URL(import.meta.url),
          storageManager: emulated(),
          cfcPosture: "max-enforcement",
        })],
      ["remoteClient", () =>
        runtimePresets.remoteClient({
          apiUrl: new URL(import.meta.url),
          storageManager: emulated(),
          experimental: {},
        })],
      [
        "remoteClient under max-enforcement, raised to strict",
        () =>
          runtimePresets.remoteClient({
            apiUrl: new URL(import.meta.url),
            storageManager: emulated(),
            experimental: {},
            cfcPosture: "max-enforcement",
            cfcEnforcementMode: "enforce-strict",
          }),
      ],
      ["productionServer", () =>
        runtimePresets.productionServer({
          apiUrl: new URL(import.meta.url),
          storageManager: emulated(),
          experimental: {},
        })],
      ["browserWorker", () =>
        runtimePresets.browserWorker({
          apiUrl: new URL(import.meta.url),
          storageManager: emulated(),
          experimental: {},
        })],
      ["patternTest", () =>
        runtimePresets.patternTest({
          apiUrl: new URL(import.meta.url),
          storageManager: emulated(),
          experimental: {},
        })],
    ];

    for (const [name, build] of cases) {
      it(`${name} projects the record its Runtime resolves`, async () => {
        // Every value equal, and exactly one field not: the projection says it
        // is a projection. That difference is the point of the field, so the
        // comparison names it rather than stripping it — a projection that
        // deep-equalled an attestation would be one nothing could tell apart.
        const options = build();
        const runtime = new Runtime(options);
        try {
          const resolved = cfcPostureReport(runtime);
          const prediction = projected(options);
          expect(resolved.provenance).toBe("resolved");
          expect(prediction.provenance).toBe("projected");
          expect(resolved).toEqual({ ...prediction, provenance: "resolved" });
        } finally {
          await runtime.dispose();
          await options.storageManager.close();
        }
      });
    }

    it("projects the same record from the preset's CFC options alone", () => {
      // What a host with no storage manager to spare can reach: the CFC
      // options a preset composes are pure, so a surface that has only a
      // session's dials still lands on the record.
      const options = runtimePresets.remoteClient({
        apiUrl: new URL(import.meta.url),
        storageManager: emulated(),
        experimental: {},
        cfcPosture: "max-enforcement",
      });
      expect(projected(options)).toEqual(
        projectedCfcPostureReport(
          presetCfcOptions({ cfcPosture: "max-enforcement" }),
        ),
      );
    });
  });
});
