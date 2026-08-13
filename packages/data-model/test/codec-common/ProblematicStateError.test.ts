import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { ProblematicStateError } from "@/codec-common/ProblematicStateError.ts";

describe("ProblematicStateError", () => {
  it("is an `Error`", () => {
    const e = new ProblematicStateError("T@1", { x: 1 }, "boom");

    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("ProblematicStateError");
    expect(e.message).toBe("boom");
  });

  describe("constructor()", () => {
    it("keeps a `FabricValue` state by identity", () => {
      const state = { x: 1 };

      expect(new ProblematicStateError("T@1", state, "boom").state).toBe(state);
    });

    it("renders a non-`FabricValue` state", () => {
      const e = new ProblematicStateError("T@1", new Uint8Array([1, 2]), "b");

      expect(typeof e.state).toBe("string");
      expect(e.state).toMatch(/Uint8Array/);
    });

    it("preserves the wire type tag", () => {
      expect(new ProblematicStateError("Bad@7", 1, "b").wireTypeTag)
        .toBe("Bad@7");
    });
  });

  describe("fromThrown()", () => {
    it("takes an `Error`'s message and keeps it as `cause`", () => {
      const thrown = new RangeError("out of range");
      const e = ProblematicStateError.fromThrown("T@1", { x: 1 }, thrown);

      expect(e.message).toBe("out of range");
      expect(e.cause).toBe(thrown);
    });

    it("renders a thrown non-`Error`, still keeping it as `cause`", () => {
      // JavaScript permits throwing anything, so there may be no message to
      // take -- but the thrown value is still the best account of what
      // happened, and is not discarded.
      for (const thrown of [{ nope: true }, "plain string", 42, undefined]) {
        const e = ProblematicStateError.fromThrown("T@1", 1, thrown);

        expect(typeof e.message).toBe("string");
        expect(e.message.length).toBeGreaterThan(0);
        expect(e.cause).toBe(thrown);
      }
    });

    it("coerces the state as the constructor does", () => {
      const e = ProblematicStateError.fromThrown(
        "T@1",
        new Uint8Array([1, 2, 3]),
        new Error("nope"),
      );

      expect(typeof e.state).toBe("string");
    });
  });
});
