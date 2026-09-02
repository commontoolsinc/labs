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

/**
 * The fixture family with one denied decision seeded onto its root run.
 *
 * `attested` additionally clears the two fields that weaken a posture, so the
 * only difference between the two arms of AUD-16's positive case is the thing
 * that arm is about.
 */
const familyRefusing = (
  reasonCode: string,
  attested = false,
  alsoCodes: readonly string[] = [],
): RunFamily => {
  const root = structuredClone(family.root);
  if (root.policyTrace.status !== "present") {
    throw new Error("the fixture's policy trace did not load");
  }
  const trace = root.policyTrace.value as unknown as {
    decisions: { decision: string; reasonCodes: string[] }[];
  };
  trace.decisions = [
    ...trace.decisions,
    { decision: "denied", reasonCodes: [reasonCode, ...alsoCodes] },
  ];
  if (attested && root.policySnapshot.status === "present") {
    const snapshot = root.policySnapshot.value as {
      cfc: { substrateStatus?: string; absenceBehavior?: string };
    };
    delete snapshot.cfc.substrateStatus;
    delete snapshot.cfc.absenceBehavior;
  }
  return { root, children: [] };
};

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
    it("names the not-attested and permissive-if-absent counts", () => {
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

  describe("counting label-driven refusals", () => {
    it("counts no denial whose reason is missing direct-command authority", () => {
      // `*_requires_direct_command` is the only denying arm of the harness's
      // CFC family, and it denies because the human did not ask for the call
      // — authority, not anything the data is labelled.
      const results = auditDeployment({
        families: [
          familyRefusing("cfc_enforce_explicit_requires_direct_command"),
        ],
        paths: [FIXTURE_RUNS_DIR],
        expectRefusals: true,
      });
      expect(
        results.find((result) => result.checkId === "AUD-16")?.message,
      ).toContain("none of which could have been a release refusal");
    });

    it("counts no denial carrying an allow-side CFC code from another producer", () => {
      // The miscount this predicate was tightened to remove: `*_read` is an
      // ALLOW-side code, so a subagent-profile denial recording it alongside
      // reads as a release refusal under a `cfc_`-prefix match.
      const results = auditDeployment({
        families: [
          familyRefusing("cfc_enforce_explicit_read", false, [
            "subagent_profile_not_allowed",
          ]),
        ],
        paths: [FIXTURE_RUNS_DIR],
        expectRefusals: true,
      });
      const refusal = results.find((result) => result.checkId === "AUD-16");
      expect(refusal?.verdict).toBe("inconclusive");
      expect(refusal?.evidence[0]?.detail).toContain("0 label-driven refusals");
    });

    it("counts the denials it did see, so a corpus is not read as quiet", () => {
      const results = auditDeployment({
        families: [familyRefusing("tool_not_allowed")],
        paths: [FIXTURE_RUNS_DIR],
        expectRefusals: true,
      });
      expect(
        results.find((result) => result.checkId === "AUD-16")?.message,
      ).toContain("1 denial");
    });

    it("reads the decisions off the run report when the trace is absent", () => {
      // The trace is the artifact whose subject they are; a tree missing it
      // still has the same list on the report, and dropping to it is what
      // lets an older tree be counted rather than read as denial-free.
      const root = structuredClone(family.root);
      if (
        root.policyTrace.status !== "present" ||
        root.runReport.status !== "present"
      ) {
        throw new Error("the fixture's policy artifacts did not load");
      }
      root.policyTrace = { status: "absent", path: root.policyTrace.path };
      const report = root.runReport.value as unknown as {
        policyDecisions: { decision: string; reasonCodes: string[] }[];
      };
      report.policyDecisions = [
        ...report.policyDecisions ?? [],
        { decision: "denied", reasonCodes: ["tool_not_allowed"] },
      ];
      const results = auditDeployment({
        families: [{ root, children: [] }],
        paths: [FIXTURE_RUNS_DIR],
        expectRefusals: true,
      });
      expect(
        results.find((result) => result.checkId === "AUD-16")?.message,
      ).toContain("1 denial");
    });

    it("stays inconclusive however adversarial the corpus is declared", () => {
      // A corpus declared adversarial cannot turn "no vocabulary" into
      // "enforcement failed"; the two are different findings.
      for (const expectRefusals of [true, false]) {
        const results = auditDeployment({
          families: [family],
          paths: [FIXTURE_RUNS_DIR],
          expectRefusals,
        });
        expect(results.find((result) => result.checkId === "AUD-16")?.verdict)
          .toBe("inconclusive");
      }
    });
  });

  describe("once a release-gating reason code exists", () => {
    // The world the check is written for. `GATING` stands in for the code a
    // release refusal would carry, so the arms that decide on refusal counts
    // are exercised rather than waiting on a vocabulary that does not exist.
    const GATING = new Set(["cfc_sink_ceiling_refused"]);

    it("fails an adversarial corpus that produced no release refusal", () => {
      const results = auditDeployment({
        families: [familyRefusing("tool_not_allowed")],
        paths: [FIXTURE_RUNS_DIR],
        expectRefusals: true,
        releaseGatingCodes: GATING,
      });
      expect(results.find((result) => result.checkId === "AUD-16")?.verdict)
        .toBe("fail");
    });

    it("warns a corpus that produced none but claimed nothing about itself", () => {
      const results = auditDeployment({
        families: [familyRefusing("tool_not_allowed")],
        paths: [FIXTURE_RUNS_DIR],
        expectRefusals: false,
        releaseGatingCodes: GATING,
      });
      expect(results.find((result) => result.checkId === "AUD-16")?.verdict)
        .toBe("warn");
    });

    it("warns a corpus whose refusals came from runs that weakened their own posture", () => {
      const results = auditDeployment({
        families: [familyRefusing("cfc_sink_ceiling_refused")],
        paths: [FIXTURE_RUNS_DIR],
        expectRefusals: true,
        releaseGatingCodes: GATING,
      });
      const refusal = results.find((result) => result.checkId === "AUD-16");
      expect(refusal?.verdict).toBe("warn");
      expect(refusal?.message).toContain("1 label-driven refusal");
    });

    it("passes once refusals exist and no run weakens its own posture", () => {
      // The only arm where the corpus shows the machinery deciding: a release
      // refusal present, and nothing recording `not-attested` or
      // `permissive-if-absent` to qualify it.
      const results = auditDeployment({
        families: [familyRefusing("cfc_sink_ceiling_refused", true)],
        paths: [FIXTURE_RUNS_DIR],
        expectRefusals: true,
        releaseGatingCodes: GATING,
      });
      expect(results.find((result) => result.checkId === "AUD-16")?.verdict)
        .toBe("pass");
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

    it("warns a deployment publishing a posture with no spec to weigh it against", () => {
      const results = auditDeployment({
        families: [family],
        paths: [FIXTURE_RUNS_DIR],
        expectRefusals: false,
        toolshedMeta: {
          status: "read",
          url: "http://stub.test/api/meta",
          cfc: ATTESTED_MAX_ENFORCEMENT_RECORD,
        },
      });
      expect(verdictOf(results, "AUD-17")).toBe("warn");
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

    it("reads a non-OK response as unreachable, naming the status", async () => {
      // A 404 or a 502 is a deployment that did not answer the question, not
      // one that answered "no posture" — the two want different verdicts.
      const meta = await readToolshedMeta(
        "http://stub.test",
        () => Promise.resolve(new Response("nope", { status: 502 })),
      );
      expect(meta.status).toBe("unreachable");
      expect(meta.status === "unreachable" ? meta.detail : "").toBe("HTTP 502");
    });

    it("reports a rejection that is not an Error without losing it", async () => {
      const meta = await readToolshedMeta(
        "http://stub.test",
        () => Promise.reject("connection reset"),
      );
      expect(meta.status === "unreachable" ? meta.detail : "").toBe(
        "connection reset",
      );
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

    it("groups the runs that recorded one posture together", () => {
      const recording = familyRecording(MAX_ENFORCEMENT_RECORD);
      const results = auditDeployment({
        families: [recording, familyRecording(MAX_ENFORCEMENT_RECORD)],
        paths: [FIXTURE_RUNS_DIR],
        expectRefusals: false,
      });
      const parity = results.find((result) => result.checkId === "AUD-18");
      expect(parity?.verdict).toBe("pass");
      // One record, both runs named under it: two entries here would be two
      // postures the corpus never had.
      expect(parity?.evidence.length).toBe(1);
      expect(parity?.evidence[0]?.detail).toContain("2 run(s)");
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
