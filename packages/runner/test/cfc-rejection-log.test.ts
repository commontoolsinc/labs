import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { isCfcCommitError, toCfcRejectLog } from "../src/cfc/rejection-log.ts";

describe("CFC rejection log sanitization", () => {
  it("returns undefined for non-CFC errors", () => {
    const error = {
      name: "StorageTransactionInconsistent",
      message: "conflict",
    };

    expect(isCfcCommitError(error)).toBe(false);
    expect(toCfcRejectLog(error)).toBeUndefined();
  });

  it("drops sensitive payload fields from input requirement errors", () => {
    const error = {
      name: "CfcInputRequirementViolationError",
      message: "input requirement failed",
      requirement: "statePreconditionPredicate",
      space: "did:key:space",
      id: "of:entity",
      type: "application/json",
      path: "/value/output",
      predicatePath: "/value/guard",
      requiredIntegrity: ["integrity.a", "integrity.b"],
      expectedValue: { secret: "redacted" },
      actualValue: { secret: "redacted" },
    };

    const log = toCfcRejectLog(error);
    expect(log).toEqual({
      name: "CfcInputRequirementViolationError",
      requirement: "statePreconditionPredicate",
      space: "did:key:space",
      id: "of:entity",
      type: "application/json",
      path: "/value/output",
      predicatePath: "/value/guard",
      requiredIntegrityCount: 2,
      maxConfidentialityCount: undefined,
      sourcePath: undefined,
      projectionPath: undefined,
      requiredReadPath: undefined,
      fuel: undefined,
    });
    expect((log as Record<string, unknown>).expectedValue).toBeUndefined();
    expect((log as Record<string, unknown>).actualValue).toBeUndefined();
  });

  it("omits raw digest and schema hash material from mismatch logs", () => {
    const digestMismatch = toCfcRejectLog({
      name: "CfcPreparedDigestMismatchError",
      message: "digest mismatch",
      expectedDigest: "aaa",
      actualDigest: "bbb",
    });
    expect(digestMismatch).toEqual({
      name: "CfcPreparedDigestMismatchError",
      digestMismatch: true,
      requirement: undefined,
      space: undefined,
      id: undefined,
      type: undefined,
      path: undefined,
      sourcePath: undefined,
      projectionPath: undefined,
      requiredReadPath: undefined,
      predicatePath: undefined,
      fuel: undefined,
      maxConfidentialityCount: undefined,
      requiredIntegrityCount: undefined,
    });
    expect((digestMismatch as Record<string, unknown>).expectedDigest)
      .toBeUndefined();
    expect((digestMismatch as Record<string, unknown>).actualDigest)
      .toBeUndefined();

    const schemaMismatch = toCfcRejectLog({
      name: "CfcSchemaHashMismatchError",
      message: "schema mismatch",
      space: "did:key:space",
      id: "of:entity",
      type: "application/json",
      expectedSchemaHash: "old",
      actualSchemaHash: "new",
    });
    expect(schemaMismatch).toEqual({
      name: "CfcSchemaHashMismatchError",
      space: "did:key:space",
      id: "of:entity",
      type: "application/json",
      schemaHashMismatch: true,
      requirement: undefined,
      path: undefined,
      sourcePath: undefined,
      projectionPath: undefined,
      requiredReadPath: undefined,
      predicatePath: undefined,
      fuel: undefined,
      maxConfidentialityCount: undefined,
      requiredIntegrityCount: undefined,
    });
    expect((schemaMismatch as Record<string, unknown>).expectedSchemaHash)
      .toBeUndefined();
    expect((schemaMismatch as Record<string, unknown>).actualSchemaHash)
      .toBeUndefined();
  });

  it("keeps non-sensitive convergence metadata", () => {
    const log = toCfcRejectLog({
      name: "CfcPolicyNonConvergenceError",
      message: "fuel exhausted",
      space: "did:key:space",
      id: "of:entity",
      type: "application/json",
      path: "/value/data",
      fuel: 8,
    });

    expect(log).toEqual({
      name: "CfcPolicyNonConvergenceError",
      space: "did:key:space",
      id: "of:entity",
      type: "application/json",
      path: "/value/data",
      fuel: 8,
      requirement: undefined,
      sourcePath: undefined,
      projectionPath: undefined,
      requiredReadPath: undefined,
      predicatePath: undefined,
      maxConfidentialityCount: undefined,
      requiredIntegrityCount: undefined,
    });
  });
});
