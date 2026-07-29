import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { type JSONSchema } from "@commonfabric/runner";
import {
  type Baseline,
  checkPattern,
  contractHash,
  type PatternContract,
} from "./pattern-compat-lib.ts";

const contract = (
  argumentSchema: JSONSchema,
  resultSchema: JSONSchema,
): PatternContract => ({ argumentSchema, resultSchema });

const baseline = (
  label: string,
  argumentSchema: JSONSchema,
  resultSchema: JSONSchema,
): Baseline => ({ label, contract: contract(argumentSchema, resultSchema) });

const EMPTY_ARGUMENT: JSONSchema = { type: "object", properties: {} };

const RESULT_WITH_TITLE: JSONSchema = {
  type: "object",
  properties: { title: { type: "string" } },
  required: ["title"],
};

/** The same contract, with `title` dropped from the result. */
const RESULT_WITHOUT_TITLE: JSONSchema = {
  type: "object",
  properties: {},
};

describe("checkPattern", () => {
  it("rejects a result schema that drops a previously promised field", () => {
    const current = contract(EMPTY_ARGUMENT, RESULT_WITHOUT_TITLE);
    const findings = checkPattern("system/home.tsx", current, [
      baseline("v1", EMPTY_ARGUMENT, RESULT_WITH_TITLE),
    ]);

    const incompatible = findings.filter((f) => f.kind === "incompatible");
    expect(incompatible.length).toBe(1);
    expect(incompatible[0]).toMatchObject({
      kind: "incompatible",
      pattern: "system/home.tsx",
      baseline: "v1",
    });
  });

  it("reports a missing baseline for a contract no file records", () => {
    const current = contract(EMPTY_ARGUMENT, RESULT_WITH_TITLE);
    const findings = checkPattern("system/home.tsx", current, []);

    expect(findings).toEqual([{
      kind: "missing-baseline",
      pattern: "system/home.tsx",
      hash: contractHash(current),
    }]);
  });

  it("passes a contract that is recorded and compatible with every baseline", () => {
    const current = contract(EMPTY_ARGUMENT, RESULT_WITH_TITLE);
    const findings = checkPattern("system/home.tsx", current, [
      baseline("v1", EMPTY_ARGUMENT, RESULT_WITH_TITLE),
    ]);

    expect(findings).toEqual([]);
  });

  it("checks against every baseline, not just the newest", () => {
    // v2 dropped `title` behind a declared break; v3 must still be proven
    // against v1, which is what a piece that has not opened since v1 holds.
    const current = contract(EMPTY_ARGUMENT, RESULT_WITHOUT_TITLE);
    const findings = checkPattern("system/home.tsx", current, [
      baseline("v1", EMPTY_ARGUMENT, RESULT_WITH_TITLE),
      baseline("v2", EMPTY_ARGUMENT, RESULT_WITHOUT_TITLE),
    ]);

    const incompatible = findings.filter((f) => f.kind === "incompatible");
    expect(incompatible.length).toBe(1);
    expect(incompatible[0]).toMatchObject({ baseline: "v1" });
  });

  it("reports a malformed schema on a contract that is not yet recorded", () => {
    // Validity is checked directly rather than as a side effect of a subset
    // proof, because the identical-contract proof is skipped. It runs only for
    // an unrecorded contract — so `--update` must refuse to record one that is
    // invalid, or the finding would never be raised again.
    const current = contract(EMPTY_ARGUMENT, {
      type: "undefined",
      scope: "bogus",
    } as unknown as JSONSchema);
    const findings = checkPattern("system/home.tsx", current, []);

    const invalid = findings.filter((f) => f.kind === "incompatible");
    expect(invalid.length).toBe(1);
    expect(invalid[0]).toMatchObject({ baseline: "(current)" });
  });

  it("reports a retired pattern whose baselines outlive its source", () => {
    const findings = checkPattern("system/gone.tsx", undefined, [
      baseline("v1", EMPTY_ARGUMENT, RESULT_WITH_TITLE),
    ]);

    expect(findings).toEqual([{
      kind: "retired",
      pattern: "system/gone.tsx",
      baselines: ["v1"],
    }]);
  });
});

describe("contractHash", () => {
  it("is stable across key order", () => {
    const a = contract(EMPTY_ARGUMENT, {
      type: "object",
      properties: { x: { type: "string" }, y: { type: "number" } },
    });
    const b = contract(EMPTY_ARGUMENT, {
      properties: { y: { type: "number" }, x: { type: "string" } },
      type: "object",
    });

    expect(contractHash(a)).toBe(contractHash(b));
  });

  it("separates contracts that differ only in the argument schema", () => {
    const a = contract(EMPTY_ARGUMENT, RESULT_WITH_TITLE);
    const b = contract({
      type: "object",
      properties: { seed: { type: "string" } },
    }, RESULT_WITH_TITLE);

    expect(contractHash(a)).not.toBe(contractHash(b));
  });
});
