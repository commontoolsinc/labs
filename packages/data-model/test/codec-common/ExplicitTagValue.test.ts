/**
 * The base shared by values that carry their own wire tag rather than taking
 * one from their class.
 *
 * There is little to pin at this level. The base only exposes what a concrete
 * subclass supplies, and what carrying a tag per instance actually means is
 * settled by the subclasses that do it.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { UnknownValue } from "@/codec-common/UnknownValue.ts";
import { ProblematicValue } from "@/codec-common/ProblematicValue.ts";
import { ExplicitTagValue } from "@/codec-common/ExplicitTagValue.ts";

describe("ExplicitTagValue", () => {
  describe("instance members", () => {
    describe("`.wireTypeTag` / `.state`", () => {
      it("provide access to the concrete subclass's tag and state", () => {
        const us: ExplicitTagValue = new UnknownValue("Tag@2", 42);
        expect(us.wireTypeTag).toBe("Tag@2");
        expect(us.state).toBe(42);

        const ps: ExplicitTagValue = new ProblematicValue(
          "Bad@1",
          "data",
          "err",
        );
        expect(ps.wireTypeTag).toBe("Bad@1");
        expect(ps.state).toBe("data");
      });
    });
  });
});
