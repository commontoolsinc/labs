import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { NodeRegistry } from "../../src/scheduler/node-record.ts";
import { invalidCauseKey } from "../../src/scheduler/invalid-cause.ts";
import type { Action } from "../../src/scheduler/types.ts";

describe("NodeRegistry", () => {
  describe("instance members", () => {
    describe("remove()", () => {
      it("returns the removed record", () => {
        const nodes = new NodeRegistry();
        const action: Action = function removed() {};
        const record = nodes.register(action, "computation");

        expect(nodes.remove(action)).toBe(record);
      });

      it("returns undefined for an unknown action", () => {
        const nodes = new NodeRegistry();
        const action: Action = function unknown() {};

        expect(nodes.remove(action)).toBeUndefined();
      });

      it("returns the record from `get()` after removal", () => {
        // The record is deliberately kept so a re-registration recovers the
        // ordinal and parent. `get()` therefore answers for a node that is no
        // longer scheduled, and cannot stand in for a registration check.
        const nodes = new NodeRegistry();
        const action: Action = function removed() {};
        nodes.register(action, "computation");
        nodes.remove(action);

        expect(nodes.get(action)).toBeDefined();
      });

      it("returns `false` from `isComputation()` after removal", () => {
        const nodes = new NodeRegistry();
        const action: Action = function removed() {};
        nodes.register(action, "computation");
        expect(nodes.isComputation(action)).toBe(true);

        nodes.remove(action);

        expect(nodes.isComputation(action)).toBe(false);
      });

      it("returns `false` from `isEffect()` after removal", () => {
        const nodes = new NodeRegistry();
        const action: Action = function removedEffect() {};
        nodes.register(action, "effect");
        expect(nodes.isEffect(action)).toBe(true);

        nodes.remove(action);

        expect(nodes.isEffect(action)).toBe(false);
      });

      it("omits the removed action from `nodes()`", () => {
        const nodes = new NodeRegistry();
        const kept: Action = function kept() {};
        const dropped: Action = function dropped() {};
        nodes.register(kept, "computation");
        nodes.register(dropped, "computation");

        nodes.remove(dropped);

        expect([...nodes.nodes()].map((record) => record.action)).toEqual([
          kept,
        ]);
      });
    });

    describe("register()", () => {
      it("keeps the first registration ordinal across a removal", () => {
        const nodes = new NodeRegistry();
        const first: Action = function first() {};
        const second: Action = function second() {};
        nodes.register(first, "computation");
        nodes.register(second, "computation");
        const ordinal = nodes.getRegistrationOrdinal(first);

        nodes.remove(first);
        nodes.register(first, "computation");

        expect(nodes.getRegistrationOrdinal(first)).toBe(ordinal);
      });

      it("deduplicates invalidation causes while dormant", () => {
        const nodes = new NodeRegistry();
        const action: Action = function dormant() {};
        const cause = {
          space: "did:key:space" as const,
          scope: "space" as const,
          id: "of:source" as const,
          path: ["value"],
        };
        const distinctCause = { ...cause, path: ["other"] };
        const token = nodes.beginSubscription(action, true);
        nodes.register(action, "effect", undefined, { dormant: true });

        nodes.deferDormantInvalidation(action, cause);
        nodes.deferDormantInvalidation(action, { ...cause, path: ["value"] });
        nodes.deferDormantInvalidation(action, distinctCause);
        nodes.activateDormantSubscription(action, token);

        expect(nodes.get(action)?.invalidCauses).toEqual([
          cause,
          distinctCause,
        ]);
      });

      it("promotes computations to effects but rejects demotion", () => {
        const nodes = new NodeRegistry();
        const action: Action = function promoted() {};
        nodes.register(action, "computation");

        nodes.register(action, "effect");
        expect(nodes.isEffect(action)).toBe(true);
        expect(() => nodes.register(action, "computation")).toThrow(
          "Scheduler action re-registered as computation; was effect",
        );
      });
    });

    describe("subscription ownership", () => {
      it("rejects stale activation and cancellation tokens", () => {
        const nodes = new NodeRegistry();
        const action: Action = function subscribed() {};
        const stale = nodes.beginSubscription(action, true);
        const current = nodes.beginSubscription(action, true);

        expect(nodes.activateDormantSubscription(action, stale))
          .toBeUndefined();
        expect(nodes.cancelSubscription(action, stale)).toBe(false);
        expect(nodes.cancelSubscription(action, current)).toBe(true);
        expect(nodes.deferDormantInvalidation(action)).toBe(false);
      });

      it("activates a dormant subscription before its node registers", () => {
        const nodes = new NodeRegistry();
        const action: Action = function unregistered() {};
        const token = nodes.beginSubscription(action, true);

        expect(nodes.deferDormantInvalidation(action)).toBe(true);
        expect(nodes.activateDormantSubscription(action, token)).toBe(true);
        expect(nodes.get(action)).toBeUndefined();
      });
    });

    describe("queries", () => {
      it("reports known kinds, active counts, and ancestry", () => {
        const nodes = new NodeRegistry();
        const root: Action = function root() {};
        const middle: Action = function middle() {};
        const leaf: Action = function leaf() {};
        nodes.register(root, "effect");
        nodes.register(middle, "computation", root);
        nodes.register(leaf, "computation", middle);

        expect(nodes.isKnownEffect(root)).toBe(true);
        expect(nodes.isKnownComputation(middle)).toBe(true);
        expect(nodes.isKnownComputation(root)).toBe(false);
        expect(nodes.size("effect")).toBe(1);
        expect(nodes.size("computation")).toBe(2);
        expect(nodes.isAncestor(leaf, root)).toBe(true);
        expect(nodes.isAncestor(root, leaf)).toBe(false);

        nodes.remove(middle);
        expect(nodes.isKnownComputation(middle)).toBe(true);
      });

      it("ignores status and parent updates for unknown actions", () => {
        const nodes = new NodeRegistry();
        const missing: Action = function missing() {};
        const parent: Action = function parent() {};

        nodes.setStatus(missing, "invalid");
        expect(nodes.linkParent(missing, parent)).toBeUndefined();
        expect(nodes.getInvalidNodes().size).toBe(0);
      });
    });
  });
});

describe("invalidCauseKey", () => {
  const address = {
    space: "did:key:space" as const,
    id: "of:source" as const,
    path: ["a", "b"],
  };

  it("normalizes omitted scope to space", () => {
    expect(invalidCauseKey(address)).toBe(
      invalidCauseKey({ ...address, scope: "space" }),
    );
  });

  it("distinguishes scopes and path segments", () => {
    expect(invalidCauseKey({ ...address, scope: "session" })).not.toBe(
      invalidCauseKey({ ...address, scope: "space" }),
    );
    expect(invalidCauseKey(address)).not.toBe(
      invalidCauseKey({ ...address, path: ["a/b"] }),
    );
  });
});
