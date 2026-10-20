import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import type { WatchSpec } from "../v2.ts";
import { cacheKeyForEntity } from "../v2/server-sync.ts";
import { SessionRegistry } from "../v2/session-registry.ts";

const space = "did:key:document-interests";
const id = "cid:historical-schema";

/** A root watch that need not load a document to represent an interest. */
function watch(branch = "", scope: "space" | "user" = "space"): WatchSpec {
  return {
    id: `${branch}-${scope}`,
    kind: "graph",
    query: {
      branch,
      roots: [{ id, scope, selector: { path: [], schema: false } }],
    },
  };
}

describe("document-interests", () => {
  it("separates spaces, branches and scope instances and bounds attribution", () => {
    const registry = new SessionRegistry();
    for (
      const [sessionSpace, branch, scope] of [
        [space, "", "space"],
        [space, "", "space"],
        [space, "other", "space"],
        [space, "", "user"],
        ["did:key:other-space", "", "space"],
      ] as const
    ) {
      const opened = registry.open(sessionSpace, {}, 0, "connection", "owner");
      const session = registry.peek(sessionSpace, opened.sessionId)!;
      session.watches = [watch(branch, scope)];
    }

    const report = registry.documentInterests({ space, id, limit: 1 });
    expect(report.totalMatches).toBe(2);
    expect(report.truncated).toBe(true);
    expect(report.sessions).toHaveLength(1);
    expect(report.sessions[0]).toMatchObject({
      principal: "owner",
      connectionId: "connection",
      watchCount: 1,
      directWatchCount: 1,
      cached: false,
      graphCount: 0,
    });
    expect(
      registry.documentInterests({ space, id, branch: "other" }).totalMatches,
    )
      .toBe(1);
    expect(registry.documentInterests({ space, id: "cid:absent" }).totalMatches)
      .toBe(0);
    for (const limit of [0, -1, 101, 1.5, NaN, Infinity]) {
      expect(() => registry.documentInterests({ space, id, limit })).toThrow(
        RangeError,
      );
    }
  });

  it("reports cache-only and expired interests without pruning or reading payloads", () => {
    const registry = new SessionRegistry();
    const opened = registry.open(
      space,
      {},
      7,
      "connection",
      "service",
      "delegated-user",
    );
    const session = registry.peek(space, opened.sessionId)!;
    const entry = {
      branch: "",
      id,
      scope: "space" as const,
      scopeKey: "space" as const,
      seq: 7,
      get doc(): never {
        throw new Error("The diagnostic must not inspect document contents");
      },
    };
    session.entities.set(cacheKeyForEntity("", id), entry);
    session.viewDemandEntities.set(cacheKeyForEntity("", id), entry);
    session.ownerConnectionId = null;
    session.expiresAt = 0;
    session.seenSeq = 7;

    const report = registry.documentInterests({ space, id });
    expect(report.totalMatches).toBe(1);
    expect(report.sessions[0]).toEqual({
      sessionId: opened.sessionId,
      principal: "service",
      actingPrincipal: "delegated-user",
      connectionId: null,
      expiresAt: 0,
      expired: true,
      watchCount: 0,
      directWatchCount: 0,
      cached: true,
      graphCount: 0,
      viewDemandCached: true,
      viewDemandGraphCount: 0,
    });
    expect(JSON.stringify(report)).not.toContain(opened.sessionToken);
    expect(registry.peek(space, opened.sessionId)).toBe(session);
    expect(session.seenSeq).toBe(7);
    expect(session.entities.get(cacheKeyForEntity("", id))).toBe(entry);
  });
});
