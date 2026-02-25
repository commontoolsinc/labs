import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { Activity } from "../src/storage/interface.ts";
import {
  canonicalizeBoundaryActivity,
  canonicalizeStoragePath,
} from "../src/cfc/canonical-activity.ts";
import { internalVerifierReadMeta } from "../src/cfc/internal-markers.ts";

describe("canonicalizeStoragePath", () => {
  it("canonicalizes /value wrapper paths", () => {
    expect(canonicalizeStoragePath(["value", "foo"])).toBe("/foo");
    expect(canonicalizeStoragePath(["value"])).toBe("/");
    expect(canonicalizeStoragePath([])).toBe("/");
  });
});

describe("canonicalizeBoundaryActivity", () => {
  it("preserves attempted write order", () => {
    const activity: Activity[] = [
      {
        write: {
          space: "did:key:test",
          id: "of:doc",
          type: "application/json",
          path: ["value", "a"],
        },
      },
      {
        write: {
          space: "did:key:test",
          id: "of:doc",
          type: "application/json",
          path: ["value", "b"],
        },
      },
    ];

    const canonical = canonicalizeBoundaryActivity(activity);
    expect(canonical.attemptedWrites.map((w) => w.path)).toEqual(["/a", "/b"]);
  });

  it("uses last attempted write in final-per-path view", () => {
    const activity: Activity[] = [
      {
        write: {
          space: "did:key:test",
          id: "of:doc",
          type: "application/json",
          path: ["value", "a"],
        },
      },
      {
        write: {
          space: "did:key:test",
          id: "of:doc",
          type: "application/json",
          path: ["value", "a"],
          changed: false,
        } as any,
      },
    ];

    const canonical = canonicalizeBoundaryActivity(activity);
    expect(canonical.finalAttemptedWrites).toHaveLength(1);
    expect(canonical.finalAttemptedWrites[0].path).toBe("/a");
    expect(canonical.finalAttemptedWrites[0].changed).toBe(false);
  });

  it("preserves internal verifier read marker", () => {
    const activity: Activity[] = [
      {
        read: {
          space: "did:key:test",
          id: "of:doc",
          type: "application/json",
          path: ["value", "secret"],
          meta: internalVerifierReadMeta,
        },
      },
    ];

    const canonical = canonicalizeBoundaryActivity(activity);
    expect(canonical.reads).toHaveLength(1);
    expect(canonical.reads[0].path).toBe("/secret");
    expect(canonical.reads[0].internalVerifierRead).toBe(true);
  });
});
