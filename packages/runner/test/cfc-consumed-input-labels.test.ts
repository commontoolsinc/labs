import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { Labels } from "../src/storage/interface.ts";
import type { CanonicalBoundaryRead } from "../src/cfc/canonical-activity.ts";
import {
  collectConsumedInputLabels,
  consumedReadEntityKey,
} from "../src/cfc/consumed-input-labels.ts";
import type { PersistedPathLabels } from "../src/cfc/shared.ts";

describe("collectConsumedInputLabels", () => {
  it("resolves the most specific matching observation label", () => {
    const reads: CanonicalBoundaryRead[] = [
      {
        space: "did:key:test",
        id: "of:doc",
        type: "application/json",
        path: "/profile/ssn/last4",
        op: "value",
        meta: {},
        internalVerifierRead: false,
      },
      {
        space: "did:key:test",
        id: "of:doc",
        type: "application/json",
        path: "/profile/name",
        op: "value",
        meta: {},
        internalVerifierRead: false,
      },
      {
        space: "did:key:test",
        id: "of:other",
        type: "application/json",
        path: "/",
        op: "value",
        meta: {},
        internalVerifierRead: false,
      },
    ];

    const labelsByEntity = new Map<string, PersistedPathLabels>([
      [
        consumedReadEntityKey(reads[0]),
        {
          "/": {
            label: {
              classification: ["confidential"],
              integrity: ["source-a"],
            },
          },
          "/profile/ssn": {
            label: {
              classification: ["secret"],
              integrity: ["source-b"],
            },
          },
        },
      ],
      [
        consumedReadEntityKey(reads[2]),
        {
          "/": { label: { classification: ["unclassified"] } },
        },
      ],
    ]);

    const labeled = collectConsumedInputLabels(reads, labelsByEntity);
    expect(labeled).toHaveLength(3);
    expect(labeled[0].effectiveLabel).toEqual({
      classification: ["secret"],
      integrity: ["source-b"],
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
        op: "value",
        meta: {},
        internalVerifierRead: false,
      },
    ];
    const labelsByEntity = new Map<string, PersistedPathLabels>();

    const labeled = collectConsumedInputLabels(reads, labelsByEntity);
    expect(labeled[0].effectiveLabel).toBeUndefined();
  });

  it("applies wildcard labels for indexed reads", () => {
    const read: CanonicalBoundaryRead = {
      space: "did:key:test",
      id: "of:doc",
      type: "application/json",
      path: "/items/0",
      op: "value",
      meta: {},
      internalVerifierRead: false,
    };

    const labelsByEntity = new Map<string, PersistedPathLabels>([
      [
        consumedReadEntityKey(read),
        {
          "/items/*": {
            label: {
              classification: ["secret"],
              integrity: ["source-a"],
            },
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

  it("preserves multi-clause confidentiality labels", () => {
    const read: CanonicalBoundaryRead = {
      space: "did:key:test",
      id: "of:doc",
      type: "application/json",
      path: "/profile/ssn",
      op: "value",
      meta: {},
      internalVerifierRead: false,
    };

    const labelsByEntity = new Map<string, PersistedPathLabels>([
      [
        consumedReadEntityKey(read),
        {
          "/": {
            label: {
              classification: [[
                {
                  type: "https://commonfabric.org/cfc/atom/User",
                  subject: "did:key:alice",
                },
              ]] as unknown as Labels["classification"],
            },
          },
          "/profile/ssn": {
            label: {
              classification: [[
                "https://commonfabric.org/cfc/atom/EmailSecret",
              ]] as unknown as Labels["classification"],
            },
          },
        },
      ],
    ]);

    const labeled = collectConsumedInputLabels([read], labelsByEntity);
    expect(labeled[0].effectiveLabel).toEqual({
      classification: [
        ["https://commonfabric.org/cfc/atom/EmailSecret"],
      ],
    });
  });
});
