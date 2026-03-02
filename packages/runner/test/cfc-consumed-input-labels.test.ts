import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { Labels } from "../src/storage/interface.ts";
import type { CanonicalBoundaryRead } from "../src/cfc/canonical-activity.ts";
import {
  collectConsumedInputLabels,
  consumedReadEntityKey,
} from "../src/cfc/consumed-input-labels.ts";

describe("collectConsumedInputLabels", () => {
  it("joins labels from matching path prefixes", () => {
    const reads: CanonicalBoundaryRead[] = [
      {
        space: "did:key:test",
        id: "of:doc",
        type: "application/json",
        path: "/profile/ssn/last4",
        meta: {},
        internalVerifierRead: false,
      },
      {
        space: "did:key:test",
        id: "of:doc",
        type: "application/json",
        path: "/profile/name",
        meta: {},
        internalVerifierRead: false,
      },
      {
        space: "did:key:test",
        id: "of:other",
        type: "application/json",
        path: "/",
        meta: {},
        internalVerifierRead: false,
      },
    ];

    const labelsByEntity = new Map<string, Record<string, Labels>>([
      [
        consumedReadEntityKey(reads[0]),
        {
          "/": {
            classification: ["confidential"],
            integrity: ["source-a"],
          },
          "/profile/ssn": {
            classification: ["secret"],
            integrity: ["source-b"],
          },
        },
      ],
      [
        consumedReadEntityKey(reads[2]),
        {
          "/": { classification: ["unclassified"] },
        },
      ],
    ]);

    const labeled = collectConsumedInputLabels(reads, labelsByEntity);
    expect(labeled).toHaveLength(3);
    expect(labeled[0].effectiveLabel).toEqual({
      classification: ["secret"],
      integrity: ["source-a", "source-b"],
    });
    expect(labeled[1].effectiveLabel).toEqual({
      classification: ["confidential"],
      integrity: ["source-a"],
    });
    expect(labeled[2].effectiveLabel).toEqual({
      classification: ["unclassified"],
    });
  });

  it("returns undefined when labels are unavailable", () => {
    const reads: CanonicalBoundaryRead[] = [
      {
        space: "did:key:test",
        id: "of:doc",
        type: "application/json",
        path: "/a/b",
        meta: {},
        internalVerifierRead: false,
      },
    ];
    const labelsByEntity = new Map<string, Record<string, Labels>>();

    const labeled = collectConsumedInputLabels(reads, labelsByEntity);
    expect(labeled[0].effectiveLabel).toBeUndefined();
  });

  it("applies wildcard labels for indexed reads", () => {
    const read: CanonicalBoundaryRead = {
      space: "did:key:test",
      id: "of:doc",
      type: "application/json",
      path: "/items/0",
      meta: {},
      internalVerifierRead: false,
    };

    const labelsByEntity = new Map<string, Record<string, Labels>>([
      [
        consumedReadEntityKey(read),
        {
          "/items/*": {
            classification: ["secret"],
            integrity: ["source-a"],
          },
        },
      ],
    ]);

    const labeled = collectConsumedInputLabels([read], labelsByEntity);
    expect(labeled[0].effectiveLabel).toEqual({
      classification: ["secret"],
      integrity: ["source-a"],
    });
  });
});
