import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { entityUriFromActionId } from "../src/lib/scheduler-graph-identity.ts";

describe("scheduler graph entity identity", () => {
  it("preserves the URI scheme when extracting an action's entity", () => {
    const hash = "fid1:same-hash-bytes";

    expect(entityUriFromActionId(`sink:did:key:test/of:${hash}/value`)).toBe(
      `of:${hash}`,
    );
    expect(
      entityUriFromActionId(`action:did:key:test/computed:${hash}/value`),
    ).toBe(`computed:${hash}`);
    expect(entityUriFromActionId(`sink:did:key:test/${hash}/value`))
      .toBeUndefined();
  });
});
