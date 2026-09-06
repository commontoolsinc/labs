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
  CFC_ENFORCEMENT_MODES,
  type CfcEnforcementMode,
  cfcPostureReport,
  inheritedCfcPostureReport,
  KNOWN_SINKS,
  projectedCfcPostureReport,
  resolveCfcDials,
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

  describe("inheritance", () => {
    it("carries every value of the parent's record across, and only restamps it", () => {
      // A host running on another host's runtime publishes that runtime's
      // posture. Recomputing the values would be a second reading that can
      // disagree with the first, which is what the one record exists to rule
      // out.
      const parent = projectedCfcPostureReport(
        presetCfcOptions({ cfcPosture: "max-enforcement" }),
      );
      const inherited = inheritedCfcPostureReport(parent);
      expect(inherited.provenance).toBe("inherited");
      expect(inherited).toEqual({ ...parent, provenance: "inherited" });
    });

    it("stamps a resolved parent's record the same way", async () => {
      // What CT-2195 lands on: the parent's record becomes an attestation,
      // and the inheriting host carries the attested values without this
      // code changing.
      const options = runtimePresets.remoteClient({
        apiUrl: new URL(import.meta.url),
        storageManager: StorageManager.emulate({ as: signer }),
        experimental: {},
        cfcPosture: "max-enforcement",
      });
      const runtime = new Runtime(options);
      try {
        const parent = cfcPostureReport(runtime);
        expect(inheritedCfcPostureReport(parent)).toEqual({
          ...parent,
          provenance: "inherited",
        });
      } finally {
        await runtime.dispose();
        await options.storageManager.close();
      }
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

  describe("the enforcement-mode ladder", () => {
    const offLadder = "enforce-strictly" as CfcEnforcementMode;

    it("refuses a name off the ladder, naming it and the ladder", () => {
      const refusal = expect(() =>
        resolveCfcDials({ cfcEnforcementMode: offLadder })
      );
      refusal.toThrow(offLadder);
      refusal.toThrow(CFC_ENFORCEMENT_MODES.join(", "));
    });

    it("resolves every name on the ladder", () => {
      for (const mode of CFC_ENFORCEMENT_MODES) {
        expect(resolveCfcDials({ cfcEnforcementMode: mode }))
          .toMatchObject({ cfcEnforcementMode: mode });
      }
    });

    it("defaults a construction that names no mode", () => {
      expect(resolveCfcDials({}).cfcEnforcementMode).toBe(
        RUNTIME_CFC_DIAL_DEFAULTS.cfcEnforcementMode,
      );
    });

    it("refuses a null, which names no member of the ladder", () => {
      expect(() =>
        resolveCfcDials({ cfcEnforcementMode: null as unknown as undefined })
      ).toThrow(CFC_ENFORCEMENT_MODES.join(", "));
    });

    it("refuses to construct a Runtime on a name off the ladder", async () => {
      const storageManager = StorageManager.emulate({ as: signer });
      try {
        expect(() =>
          new Runtime({
            apiUrl: new URL(import.meta.url),
            storageManager,
            cfcEnforcementMode: offLadder,
          })
        ).toThrow(offLadder);
      } finally {
        await storageManager.close();
      }
    });

    it("refuses to project a posture on a name off the ladder", () => {
      // A posture record is published before its runtime exists, so a
      // projection that answered here would announce a rung nothing runs at.
      expect(() => projectedCfcPostureReport({ cfcEnforcementMode: offLadder }))
        .toThrow(offLadder);
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
