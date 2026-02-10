import { beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { SubscriptionManager } from "../v2-subscription.ts";
import type { Subscription } from "../v2-subscription.ts";
import type { InvocationId } from "../v2-protocol.ts";
import type { Commit, StoredFact } from "../v2-types.ts";
import { refer } from "../reference.ts";
import type { Reference } from "merkle-reference";

function makeCommit(
  version: number,
  branch: string,
  entityIds: string[],
): Commit {
  const hash = refer({ v: version, b: branch }) as unknown as Reference;
  const facts: StoredFact[] = entityIds.map((id) => ({
    hash: refer({ id, version }) as unknown as Reference,
    fact: {
      type: "set" as const,
      id: id as import("../v2-types.ts").EntityId,
      value: { version },
      parent: hash,
    },
    version,
    commitHash: hash,
  }));
  return {
    hash,
    version,
    branch,
    facts,
    createdAt: new Date().toISOString(),
  };
}

describe("v2-subscription", () => {
  let mgr: SubscriptionManager;

  beforeEach(() => {
    mgr = new SubscriptionManager();
  });

  // -----------------------------------------------------------------------
  // Registration
  // -----------------------------------------------------------------------

  describe("add/remove/get", () => {
    it("adds a subscription", () => {
      const sub: Subscription = {
        id: "job:sub1" as InvocationId,
        select: { "*": {} },
        since: 0,
        branch: "",
      };
      mgr.add(sub);
      expect(mgr.size).toBe(1);
      expect(mgr.get("job:sub1" as InvocationId)).toBe(sub);
    });

    it("removes a subscription", () => {
      mgr.add({
        id: "job:sub2" as InvocationId,
        select: { "*": {} },
        since: 0,
        branch: "",
      });
      expect(mgr.remove("job:sub2" as InvocationId)).toBe(true);
      expect(mgr.size).toBe(0);
    });

    it("returns false when removing nonexistent subscription", () => {
      expect(mgr.remove("job:nope" as InvocationId)).toBe(false);
    });

    it("replaces existing subscription with same ID", () => {
      const sub1: Subscription = {
        id: "job:dup" as InvocationId,
        select: { "*": {} },
        since: 0,
        branch: "",
      };
      const sub2: Subscription = {
        id: "job:dup" as InvocationId,
        select: { "urn:entity:specific": {} },
        since: 5,
        branch: "",
      };
      const old = mgr.add(sub1);
      expect(old).toBeUndefined();
      const replaced = mgr.add(sub2);
      expect(replaced).toBe(sub1);
      expect(mgr.size).toBe(1);
      expect(mgr.get("job:dup" as InvocationId)!.since).toBe(5);
    });

    it("clears all subscriptions", () => {
      mgr.add({
        id: "job:a" as InvocationId,
        select: { "*": {} },
        since: 0,
        branch: "",
      });
      mgr.add({
        id: "job:b" as InvocationId,
        select: { "*": {} },
        since: 0,
        branch: "",
      });
      mgr.clear();
      expect(mgr.size).toBe(0);
    });

    it("lists all subscriptions", () => {
      mgr.add({
        id: "job:x" as InvocationId,
        select: { "*": {} },
        since: 0,
        branch: "",
      });
      mgr.add({
        id: "job:y" as InvocationId,
        select: { "*": {} },
        since: 0,
        branch: "",
      });
      const list = mgr.list();
      expect(list.length).toBe(2);
    });
  });

  // -----------------------------------------------------------------------
  // Matching
  // -----------------------------------------------------------------------

  describe("match", () => {
    it("matches wildcard subscription against any entity", () => {
      mgr.add({
        id: "job:wild" as InvocationId,
        select: { "*": {} },
        since: 0,
        branch: "",
      });

      const commit = makeCommit(1, "", ["urn:entity:a", "urn:entity:b"]);
      const updates = mgr.match(commit);
      expect(updates.length).toBe(1);
      expect(updates[0].subscriptionId).toBe("job:wild");
      expect(updates[0].revisions.length).toBe(2);
    });

    it("matches specific entity subscription", () => {
      mgr.add({
        id: "job:specific" as InvocationId,
        select: { "urn:entity:target": {} },
        since: 0,
        branch: "",
      });

      const commit = makeCommit(1, "", [
        "urn:entity:target",
        "urn:entity:other",
      ]);
      const updates = mgr.match(commit);
      expect(updates.length).toBe(1);
      expect(updates[0].revisions.length).toBe(1);
    });

    it("skips subscription when no matching entities", () => {
      mgr.add({
        id: "job:miss" as InvocationId,
        select: { "urn:entity:nope": {} },
        since: 0,
        branch: "",
      });

      const commit = makeCommit(1, "", ["urn:entity:other"]);
      const updates = mgr.match(commit);
      expect(updates.length).toBe(0);
    });

    it("filters by branch", () => {
      mgr.add({
        id: "job:main-only" as InvocationId,
        select: { "*": {} },
        since: 0,
        branch: "",
      });
      mgr.add({
        id: "job:feature-only" as InvocationId,
        select: { "*": {} },
        since: 0,
        branch: "feature",
      });

      const mainCommit = makeCommit(1, "", ["urn:entity:a"]);
      const featureCommit = makeCommit(2, "feature", ["urn:entity:b"]);

      const mainUpdates = mgr.match(mainCommit);
      expect(mainUpdates.length).toBe(1);
      expect(mainUpdates[0].subscriptionId).toBe("job:main-only");

      const featureUpdates = mgr.match(featureCommit);
      expect(featureUpdates.length).toBe(1);
      expect(featureUpdates[0].subscriptionId).toBe("job:feature-only");
    });

    it("advances watermark after match", () => {
      mgr.add({
        id: "job:wm" as InvocationId,
        select: { "*": {} },
        since: 0,
        branch: "",
      });

      const commit1 = makeCommit(1, "", ["urn:entity:a"]);
      const commit2 = makeCommit(2, "", ["urn:entity:b"]);

      mgr.match(commit1);
      // Watermark should now be 1
      expect(mgr.get("job:wm" as InvocationId)!.since).toBe(1);

      const updates = mgr.match(commit2);
      expect(updates.length).toBe(1);
      expect(mgr.get("job:wm" as InvocationId)!.since).toBe(2);
    });

    it("skips commits at or below the watermark", () => {
      mgr.add({
        id: "job:stale" as InvocationId,
        select: { "*": {} },
        since: 5,
        branch: "",
      });

      const oldCommit = makeCommit(3, "", ["urn:entity:a"]);
      const sameCommit = makeCommit(5, "", ["urn:entity:b"]);
      const newCommit = makeCommit(6, "", ["urn:entity:c"]);

      expect(mgr.match(oldCommit).length).toBe(0);
      expect(mgr.match(sameCommit).length).toBe(0);
      expect(mgr.match(newCommit).length).toBe(1);
    });

    it("matches multiple subscriptions simultaneously", () => {
      mgr.add({
        id: "job:all" as InvocationId,
        select: { "*": {} },
        since: 0,
        branch: "",
      });
      mgr.add({
        id: "job:one" as InvocationId,
        select: { "urn:entity:a": {} },
        since: 0,
        branch: "",
      });

      const commit = makeCommit(1, "", ["urn:entity:a", "urn:entity:b"]);
      const updates = mgr.match(commit);
      expect(updates.length).toBe(2);
    });
  });
});
