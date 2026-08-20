import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { describeThrown } from "../describe-thrown.ts";

describe("describe-thrown", () => {
  describe("describeThrown()", () => {
    it("returns the message of an `Error`", () => {
      expect(describeThrown(new Error("the key store is not open"))).toBe(
        "the key store is not open",
      );
    });

    it("returns the first line of a page exception's description", () => {
      // The shape the browser protocol reports an uncaught page exception in.
      const pageException = {
        exceptionId: 1,
        text: "Uncaught",
        exception: {
          className: "Error",
          description:
            "Error: the key store is not open\n    at globalThis.app.setIdentity (<anonymous>:3:15)",
        },
      };
      expect(describeThrown(pageException)).toBe(
        "Error: the key store is not open",
      );
    });

    it("points at the cause for a value it cannot summarize", () => {
      expect(describeThrown({ exceptionId: 1, text: "Uncaught" })).toBe(
        "see the value reported as the cause below",
      );
      expect(describeThrown("a bare string")).toBe(
        "see the value reported as the cause below",
      );
      expect(describeThrown(undefined)).toBe(
        "see the value reported as the cause below",
      );
      expect(describeThrown(null)).toBe(
        "see the value reported as the cause below",
      );
    });

    it("points at the cause for an empty description", () => {
      expect(describeThrown({ exception: { description: "" } })).toBe(
        "see the value reported as the cause below",
      );
    });
  });
});
