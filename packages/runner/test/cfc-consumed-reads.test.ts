import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { Activity } from "../src/storage/interface.ts";
import { partitionConsumedBoundaryReads } from "../src/cfc/consumed-reads.ts";
import { internalVerifierReadAnnotations } from "../src/cfc/internal-markers.ts";

describe("partitionConsumedBoundaryReads", () => {
  it("excludes internal verifier reads from consumed reads", () => {
    const activity: Activity[] = [
      {
        read: {
          space: "did:key:test",
          id: "of:doc",
          type: "application/json",
          path: ["value", "public"],
          meta: {},
        },
      },
      {
        read: {
          space: "did:key:test",
          id: "of:doc",
          type: "application/json",
          path: ["value", "cfc", "schemaHash"],
          meta: {},
          cfc: internalVerifierReadAnnotations,
        },
      },
    ];

    const partitioned = partitionConsumedBoundaryReads(activity);
    expect(partitioned.consumedReads).toHaveLength(1);
    expect(partitioned.consumedReads[0].path).toBe("/public");
    expect(partitioned.internalVerifierReads).toHaveLength(1);
    expect(partitioned.internalVerifierReads[0].path).toBe("/cfc/schemaHash");
  });

  it("retains non-internal reads in consumed set", () => {
    const activity: Activity[] = [
      {
        read: {
          space: "did:key:test",
          id: "of:doc-a",
          type: "application/json",
          path: ["value", "a"],
          meta: {},
        },
      },
      {
        read: {
          space: "did:key:test",
          id: "of:doc-b",
          type: "application/json",
          path: ["value", "b"],
          meta: {},
        },
      },
    ];

    const partitioned = partitionConsumedBoundaryReads(activity);
    expect(partitioned.consumedReads.map((read) => read.path)).toEqual([
      "/a",
      "/b",
    ]);
    expect(partitioned.internalVerifierReads).toEqual([]);
  });
});
