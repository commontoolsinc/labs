import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { memoBy } from "./voter-memo.ts";

/** A stand-in for a profile cell: an entity id, and the space it lives in. */
interface Voter {
  id: string;
  space: string;
}

const keyOf = (voter: Voter) => voter.id;
const sameLink = (a: Voter, b: Voter) => a.id === b.id && a.space === b.space;

describe("voter-memo", () => {
  describe("memoBy", () => {
    it("computes once for a subject seen again", () => {
      const computed: Voter[] = [];
      const nameOf = memoBy(keyOf, sameLink, (voter: Voter) => {
        computed.push(voter);
        return `name of ${voter.id}`;
      });
      const alice: Voter = { id: "profile", space: "did:key:alice" };

      expect(nameOf(alice)).toBe("name of profile");
      expect(nameOf({ ...alice })).toBe("name of profile");
      expect(computed).toHaveLength(1);
    });

    it("keeps apart two subjects that share a key but are not the same", () => {
      const nameOf = memoBy(
        keyOf,
        sameLink,
        (voter: Voter) => `${voter.id} in ${voter.space}`,
      );
      const alice: Voter = { id: "profile", space: "did:key:alice" };
      const bob: Voter = { id: "profile", space: "did:key:bob" };

      expect(nameOf(alice)).toBe("profile in did:key:alice");
      expect(nameOf(bob)).toBe("profile in did:key:bob");
      expect(nameOf(alice)).toBe("profile in did:key:alice");
      expect(nameOf(bob)).toBe("profile in did:key:bob");
    });

    it("computes each time for a subject with no key", () => {
      let computed = 0;
      const answer = memoBy(
        () => undefined,
        sameLink,
        (_voter: Voter) => ++computed,
      );
      const alice: Voter = { id: "profile", space: "did:key:alice" };

      expect(answer(alice)).toBe(1);
      expect(answer(alice)).toBe(2);
    });

    it("remembers a computed `undefined` as an answer", () => {
      let computed = 0;
      const rosterEntry = memoBy(keyOf, sameLink, (_voter: Voter) => {
        computed++;
        return undefined;
      });
      const stranger: Voter = { id: "gone", space: "did:key:stranger" };

      expect(rosterEntry(stranger)).toBeUndefined();
      expect(rosterEntry(stranger)).toBeUndefined();
      expect(computed).toBe(1);
    });
  });
});
