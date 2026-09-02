/**
 * The Group D checks, each held to the shape it is supposed to catch.
 *
 * These read a corpus rather than a run, so a case here builds the corpus:
 * the fixture family, with a posture record installed where the check reads
 * one. The `/api/meta` cases serve a stub over loopback rather than reaching
 * a deployment — the check's subject is what a payload says, and a real
 * toolshed would make the suite a test of the network.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { join } from "@std/path";

import { harnessFabricSessionPosture } from "../../src/cfc-posture.ts";
import type { HarnessRunState } from "../../src/run-state.ts";
import { auditDeployment, CORPUS_RUN_ID } from "../checks/deployment.ts";
import { readToolshedMeta } from "../cli.ts";
import { loadRunFamily, type RunFamily } from "../evidence.ts";
import { parseExpectedPosture } from "../expected-posture.ts";
import type { CheckResult, CheckVerdict } from "../report.ts";
import { FIXTURE_RUN_ID, FIXTURE_RUNS_DIR } from "./regenerate-fixtures.ts";

const family = await loadRunFamily(join(FIXTURE_RUNS_DIR, FIXTURE_RUN_ID));

const MAX_ENFORCEMENT_RECORD = harnessFabricSessionPosture({
  apiUrl: "https://fabric.test/",
  identityKeyPath: "/dev/null",
  space: "did:key:deployment",
  cfcPosture: "max-enforcement",
});

/**
 * The same posture as a deployment would publish it: read off a constructed
 * Runtime rather than projected. `/api/meta` serves this kind.
 */
const ATTESTED_MAX_ENFORCEMENT_RECORD = {
  ...MAX_ENFORCEMENT_RECORD,
  provenance: "resolved",
} as const;

const FLEET_RECORD = harnessFabricSessionPosture({
  apiUrl: "https://fabric.test/",
  identityKeyPath: "/dev/null",
  space: "did:key:deployment",
});

const MAX_ENFORCEMENT_SPEC = parseExpectedPosture({
  label: "max-enforcement",
  flowLabels: "persist",
  writeFloor: "enforce",
  triggerReadGating: true,
  ceilingedSinks: ["fetchText", "fetchJson"],
  ungatedSinks: ["llm", "llmDialog", "generateText", "generateObject"],
});

/** The fixture family with `record` installed as the root run's posture. */
const familyRecording = (
  record: typeof MAX_ENFORCEMENT_RECORD | undefined,
): RunFamily => {
  const root = structuredClone(family.root);
  if (root.runState.status === "present" && record !== undefined) {
    (root.runState.value as HarnessRunState).fabricSessionCfc = {
      enforcementMode: "enforce-explicit",
      enforcementModeSource: "preset-pin",
      flowLabels: record.flowLabels.rung as "off" | "observe" | "persist",
      flowLabelsSource: "posture",
      posture: "max-enforcement",
      record,
    };
  }
  return { root, children: [] };
};

const verdictOf = (
  results: readonly CheckResult[],
  checkId: string,
): CheckVerdict | undefined =>
  results.find((result) => result.checkId === checkId)?.verdict;

describe("Group D deployment checks", () => {
  describe("AUD-16 refusal liveness", () => {
    it("warns a corpus with no label-driven refusal", () => {
      const results = auditDeployment({
        families: [family],
        paths: [FIXTURE_RUNS_DIR],
        expectRefusals: false,
      });
      expect(verdictOf(results, "AUD-16")).toBe("warn");
    });

    it("fails the same corpus once it is declared adversarial", () => {
      const results = auditDeployment({
        families: [family],
        paths: [FIXTURE_RUNS_DIR],
        expectRefusals: true,
      });
      expect(verdictOf(results, "AUD-16")).toBe("fail");
    });

    it("names the not-attested and permissive-if-absent counts either way", () => {
      const [result] = auditDeployment({
        families: [family],
        paths: [FIXTURE_RUNS_DIR],
        expectRefusals: false,
      });
      expect(
        result!.evidence.map((evidence) => evidence.pointer),
      ).toContain("cfc.substrateStatus");
      expect(
        result!.evidence.map((evidence) => evidence.pointer),
      ).toContain("cfc.absenceBehavior");
    });
  });

  describe("AUD-17 toolshed posture", () => {
    it("fails a deployment whose /api/meta publishes no posture", () => {
      const results = auditDeployment({
        families: [family],
        paths: [FIXTURE_RUNS_DIR],
        expectRefusals: false,
        expected: MAX_ENFORCEMENT_SPEC,
        toolshedMeta: {
          status: "read",
          url: "http://stub.test/api/meta",
          cfc: null,
        },
      });
      expect(verdictOf(results, "AUD-17")).toBe("fail");
    });

    it("passes a deployment whose published posture satisfies the spec", () => {
      const results = auditDeployment({
        families: [family],
        paths: [FIXTURE_RUNS_DIR],
        expectRefusals: false,
        expected: MAX_ENFORCEMENT_SPEC,
        toolshedMeta: {
          status: "read",
          url: "http://stub.test/api/meta",
          cfc: ATTESTED_MAX_ENFORCEMENT_RECORD,
        },
      });
      expect(verdictOf(results, "AUD-17")).toBe("pass");
    });

    it("fails a deployment whose published posture misses a field the spec asserts", () => {
      const results = auditDeployment({
        families: [family],
        paths: [FIXTURE_RUNS_DIR],
        expectRefusals: false,
        expected: MAX_ENFORCEMENT_SPEC,
        toolshedMeta: {
          status: "read",
          url: "http://stub.test/api/meta",
          cfc: { ...FLEET_RECORD, provenance: "resolved" },
        },
      });
      expect(verdictOf(results, "AUD-17")).toBe("fail");
    });

    it("fails a deployment that publishes a projection rather than an attestation", () => {
      const results = auditDeployment({
        families: [family],
        paths: [FIXTURE_RUNS_DIR],
        expectRefusals: false,
        expected: MAX_ENFORCEMENT_SPEC,
        toolshedMeta: {
          status: "read",
          url: "http://stub.test/api/meta",
          cfc: MAX_ENFORCEMENT_RECORD,
        },
      });
      // MAX_ENFORCEMENT_RECORD is the harness's projection, and satisfies
      // every field the spec asserts — so the only thing that can fail it here
      // is the kind of record it is.
      expect(verdictOf(results, "AUD-17")).toBe("fail");
    });

    it("is absent when no deployment was named", () => {
      const results = auditDeployment({
        families: [family],
        paths: [FIXTURE_RUNS_DIR],
        expectRefusals: false,
      });
      expect(verdictOf(results, "AUD-17")).toBeUndefined();
    });
  });

  describe("reading a deployment's published posture", () => {
    it("reads the record a stub serves on /api/meta", async () => {
      // A stub over the fetch seam rather than a listening socket: the
      // check's subject is the payload, and a port is not part of it.
      const meta = await readToolshedMeta(
        "http://stub.test",
        () =>
          Promise.resolve(
            new Response(JSON.stringify({ cfc: MAX_ENFORCEMENT_RECORD })),
          ),
      );
      expect(meta.status).toBe("read");
      expect(meta.status === "read" ? meta.cfc : undefined)
        .toEqual(MAX_ENFORCEMENT_RECORD);
    });

    it("reads a null record as a deployment that published nothing", async () => {
      const meta = await readToolshedMeta(
        "http://stub.test",
        () => Promise.resolve(new Response(JSON.stringify({ cfc: null }))),
      );
      expect(meta.status === "read" ? meta.cfc : undefined).toBe(null);
    });

    it("reports an unreachable deployment rather than throwing", async () => {
      const meta = await readToolshedMeta(
        "http://stub.test",
        () => Promise.reject(new Error("connection refused")),
      );
      expect(meta.status).toBe("unreachable");
    });
  });

  describe("AUD-18 surface parity", () => {
    it("is inconclusive over a corpus that recorded no posture", () => {
      const results = auditDeployment({
        families: [family],
        paths: [FIXTURE_RUNS_DIR],
        expectRefusals: false,
      });
      expect(verdictOf(results, "AUD-18")).toBe("inconclusive");
    });

    it("passes a corpus whose runs recorded one posture", () => {
      const recording = familyRecording(MAX_ENFORCEMENT_RECORD);
      const results = auditDeployment({
        families: [recording],
        paths: [FIXTURE_RUNS_DIR],
        expectRefusals: false,
      });
      expect(verdictOf(results, "AUD-18")).toBe("pass");
    });

    it("warns a corpus whose surfaces recorded different postures", () => {
      const results = auditDeployment({
        families: [
          familyRecording(MAX_ENFORCEMENT_RECORD),
          familyRecording(FLEET_RECORD),
        ],
        paths: [FIXTURE_RUNS_DIR],
        expectRefusals: false,
      });
      expect(verdictOf(results, "AUD-18")).toBe("warn");
    });

    it("fails when one of those postures does not satisfy the spec", () => {
      const results = auditDeployment({
        families: [
          familyRecording(MAX_ENFORCEMENT_RECORD),
          familyRecording(FLEET_RECORD),
        ],
        paths: [FIXTURE_RUNS_DIR],
        expectRefusals: false,
        expected: MAX_ENFORCEMENT_SPEC,
      });
      expect(verdictOf(results, "AUD-18")).toBe("fail");
    });
  });

  describe("AUD-19 render ceiling", () => {
    it("stays unattestable, because nothing publishes it", () => {
      const results = auditDeployment({
        families: [family],
        paths: [FIXTURE_RUNS_DIR],
        expectRefusals: false,
      });
      const render = results.find((result) => result.checkId === "AUD-19");
      expect(render?.verdict).toBe("inconclusive");
      expect(render?.runId).toBe(CORPUS_RUN_ID);
    });
  });
});
