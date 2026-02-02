import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  accumulateTaint,
  CFCViolationError,
  checkClearance,
  checkWrite,
  createActionContext,
} from "../src/cfc/action-context.ts";
import {
  emptyLabel,
  type Label,
  labelFromClassification,
  labelFromSchemaIfc,
} from "../src/cfc/labels.ts";
import { userAtom } from "../src/cfc/atoms.ts";
import {
  type CFCViolation,
  describeViolation,
  formatLabel,
} from "../src/cfc/violations.ts";
import { emptyIntegrity } from "../src/cfc/integrity.ts";

describe("Taint accumulation", () => {
  it("starts with empty taint", () => {
    const ctx = createActionContext({
      userDid: "did:alice",
      space: "space:work",
    });
    expect(ctx.accumulatedTaint.confidentiality).toEqual([]);
  });

  it("accumulates taint from reads", () => {
    const ctx = createActionContext({
      userDid: "did:alice",
      space: "space:work",
    });
    const secretLabel = labelFromClassification("secret");
    accumulateTaint(ctx, secretLabel);
    expect(ctx.accumulatedTaint.confidentiality.length).toBeGreaterThan(0);
  });

  it("join of multiple reads produces combined taint", () => {
    const ctx = createActionContext({
      userDid: "did:alice",
      space: "space:work",
    });
    accumulateTaint(ctx, labelFromSchemaIfc({ classification: ["secret"] }));
    accumulateTaint(
      ctx,
      labelFromSchemaIfc({ classification: ["confidential"] }),
    );
    expect(ctx.accumulatedTaint.confidentiality.length).toBe(2);
  });
});

describe("Write checks", () => {
  it("allows write when taint <= write target", () => {
    const ctx = createActionContext({
      userDid: "did:alice",
      space: "space:work",
    });
    accumulateTaint(ctx, labelFromClassification("secret"));
    expect(() => checkWrite(ctx, labelFromClassification("secret"), [])).not
      .toThrow();
  });

  it("blocks write-down (secret taint to unclassified target)", () => {
    const ctx = createActionContext({
      userDid: "did:alice",
      space: "space:work",
    });
    accumulateTaint(ctx, labelFromClassification("secret"));
    expect(() => checkWrite(ctx, emptyLabel(), [])).toThrow(CFCViolationError);
  });

  it("allows write to empty target when no taint", () => {
    const ctx = createActionContext({
      userDid: "did:alice",
      space: "space:work",
    });
    expect(() => checkWrite(ctx, emptyLabel(), [])).not.toThrow();
  });

  it("write-up is allowed (unclassified taint to secret target)", () => {
    const ctx = createActionContext({
      userDid: "did:alice",
      space: "space:work",
    });
    expect(() => checkWrite(ctx, labelFromClassification("secret"), [])).not
      .toThrow();
  });
});

describe("Exchange rule declassification", () => {
  it("exchange rule enables write that would otherwise fail", () => {
    const ctx = createActionContext({
      userDid: "did:alice",
      space: "space:work",
    });
    const userLabel: Label = {
      confidentiality: [[userAtom("did:alice")]],
      integrity: emptyIntegrity(),
    };
    accumulateTaint(ctx, userLabel);

    expect(() => checkWrite(ctx, emptyLabel(), [])).toThrow(CFCViolationError);
  });
});

describe("Violation errors", () => {
  it("CFCViolationError has structured fields", () => {
    const taint = labelFromClassification("secret");
    const target = emptyLabel();
    const error = new CFCViolationError("write-down", taint, target);
    expect(error.kind).toBe("write-down");
    expect(error.accumulatedTaint).toBe(taint);
    expect(error.writeTargetLabel).toBe(target);
    expect(error.message).toContain("write-down");
    expect(error.message).toContain("secret");
  });

  it("formatLabel produces readable output", () => {
    const label = labelFromClassification("secret");
    const formatted = formatLabel(label);
    expect(formatted).toContain("secret");
  });

  it("describeViolation produces summary", () => {
    const violation: CFCViolation = {
      kind: "write-down",
      accumulatedTaint: labelFromClassification("secret"),
      writeTargetLabel: emptyLabel(),
      summary: "",
    };
    const desc = describeViolation(violation);
    expect(desc).toContain("write-down");
    expect(desc).toContain("secret");
  });
});

describe("Backwards compatibility", () => {
  it("empty labels never cause violations", () => {
    const ctx = createActionContext({
      userDid: "did:alice",
      space: "space:work",
    });
    expect(() => checkWrite(ctx, emptyLabel(), [])).not.toThrow();
  });

  it("labelFromSchemaIfc with no ifc returns empty label", () => {
    const label = labelFromSchemaIfc({});
    expect(label).toEqual(emptyLabel());
  });

  it("checkClearance exported and callable", () => {
    const ctx = createActionContext({
      userDid: "did:alice",
      space: "space:work",
    });
    expect(() => checkClearance(ctx, emptyLabel())).not.toThrow();
  });
});
